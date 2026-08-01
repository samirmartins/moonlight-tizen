#include "moonlight_wasm.hpp"

#include <opus_multistream.h>
#include "audio_ring.hpp"

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

#include <emscripten.h>

// Audio is rendered through the Web Audio API rather than through an EMSS
// audio track. The EMSS track ties audio to the same hardware A/V pipeline as
// video and schedules it by PTS, and on Tizen that pipeline is what stutters;
// no amount of care in how it is fed changes that. Feeding it more carefully
// was tried first and did not help.
//
// The corroborating evidence is github.com/ruanformigoni/moonlight-tizen: it
// abandoned the EMSS audio track in one of its first commits and needed about
// a dozen iterations before settling on Web Audio. Nobody walks that path if
// the track can be made to behave.
//
// The path has three stages, none of which can block the socket receiver:
//
//   network thread  ──memcpy encoded packet──►  ring buffer
//   feeder thread   ──decode Opus──►  shared PCM ring
//   audio thread    ──AudioWorklet pull──►  hardware output
//
// On engines without AudioWorklet, a ScriptProcessor fallback pulls larger
// blocks from the same ring. Neither backend allocates a source node per Opus
// packet, and the main thread receives no per-frame proxy calls on the primary
// path. The scheduler and feature detection live in platform/audio.js.

// Default depth of the jitter buffer when the user has not chosen one. This is
// the setpoint the scheduler's rate servo holds, not a threshold above which
// audio is thrown away; see platform/audio.js.
static constexpr int kDefaultJitterMs = 100;

// Minimum interval between audio problem log lines. This code runs on the audio
// path, and logging crosses into JS; an unthrottled line per lost packet is
// enough to keep the backlog that caused it from ever clearing.
static constexpr uint32_t kAudioLogIntervalMs = 1000;

static int s_jitterFrames = 0;
static double s_frameDurationMs = 0.0;

static size_t s_samplesPerFrame = 0;
static size_t s_channelCount = 0;
static int s_sampleRate = 0;

static OpusMSDecoder* s_OpusDecoder = nullptr;

static std::atomic<uint32_t> s_lastAudioLogMs{0};

// Logs at most one line per kAudioLogIntervalMs, dropping the rest
static void LogAudioThrottled(const char* message) {
  uint32_t nowMs = LiGetMillis();
  uint32_t lastMs = s_lastAudioLogMs.load(std::memory_order_relaxed);
  if (nowMs - lastMs < kAudioLogIntervalMs) {
    return;
  }
  if (!s_lastAudioLogMs.compare_exchange_strong(
        lastMs, nowMs, std::memory_order_relaxed)) {
    return;
  }
  MoonlightInstance::ClLogMessage("%s\n", message);
}

// ─── Encoded packet queue (network thread → feeder thread) ────────────────────
// Fixed-size preallocated slots, so the network thread never allocates.
// 4 KiB is far beyond the largest legal Opus packet (1275 bytes, RFC 6716).
static constexpr int kMaxPacketBytes = 4096;

struct PacketSlot {
  uint8_t data[kMaxPacketBytes];
  int length;
};

static std::vector<PacketSlot> s_pktQueue; // circular, capacity s_pktCap
static int s_pktHead = 0;
static int s_pktTail = 0;
static int s_pktCount = 0;
static int s_pktCap = 0;
static std::mutex s_pktMutex;
static std::condition_variable s_pktCv;

// ─── Decoded PCM ring ────────────────────────────────────────────────────────
// 65536 frames are 1.36 seconds at 48 kHz. This is intentionally much deeper
// than the active target (normally 20-100 ms): capacity absorbs a temporarily
// unavailable backend, while the consumer's target controls actual latency.
// A power of two makes wrap arithmetic cheap in the AudioWorklet hot path.
static constexpr size_t kPcmRingFrames = 65536;
static constexpr size_t kMaxAudioChannels = 8;
static constexpr int kMaxFrameElems = 4096; // 480 samples * 8 channels = 3840
static opus_int16 s_decodeFrame[kMaxFrameElems];
static AudioPcmRing<kPcmRingFrames, kMaxAudioChannels> s_pcmRing;

// Incremented for every stream. The scheduler stamps the generation it was
// configured with onto everything it does and ignores frames from any other, so
// a frame published by the previous stream's feeder while teardown was still in
// flight cannot be scheduled against the new stream's clock.
static std::atomic<uint32_t> s_audioGeneration{0};

// ─── Feeder thread ───────────────────────────────────────────────────────────
static std::thread s_feederThread;
static std::atomic<bool> s_feederRunning{false};

static void FeederLoop() {
  while (s_feederRunning.load(std::memory_order_relaxed)) {
    // Drain the encoded queue, decode, hand each frame to the JS scheduler
    while (true) {
      uint8_t pktData[kMaxPacketBytes];
      int pktLen = 0;
      {
        std::unique_lock<std::mutex> lock(s_pktMutex);
        if (s_pktCount == 0) {
          break;
        }
        const PacketSlot& slot = s_pktQueue[s_pktHead];
        pktLen = slot.length;
        memcpy(pktData, slot.data, static_cast<size_t>(pktLen));
        s_pktHead = (s_pktHead + 1) % s_pktCap;
        --s_pktCount;
      } // release the lock before decoding, Opus is the expensive part

      // A queued length of zero is the marker for a packet the network lost.
      // Passing a null pointer to the decoder invokes Opus packet loss
      // concealment, which interpolates from the previous frame instead of
      // leaving a hole. A hole is audible as a click; the concealed frame is
      // not, and it also keeps the decoder's internal state continuous for the
      // frames that follow.
      int decodeLen;
      if (pktLen == 0) {
        decodeLen = opus_multistream_decode(
          s_OpusDecoder, nullptr, 0,
          s_decodeFrame, static_cast<int>(s_samplesPerFrame), 0
        );
      } else {
        decodeLen = opus_multistream_decode(
          s_OpusDecoder, pktData, pktLen,
          s_decodeFrame, static_cast<int>(s_samplesPerFrame), 0
        );
      }

      if (decodeLen <= 0) {
        LogAudioThrottled("Audio: Opus decode failed");
        continue;
      }

      // Publish decoded PCM directly into the pull renderer's shared ring. The
      // release store of writeFrame occurs only after every sample is copied,
      // so the worklet can never observe a partially written frame.
      if (!s_pcmRing.Push(s_decodeFrame, static_cast<uint32_t>(decodeLen),
                          static_cast<uint32_t>(s_channelCount))) {
        LogAudioThrottled("Audio: decoded PCM ring rejected a frame");
      }
    }

    // Wait for the next packet. The queue state is changed under the same mutex
    // used by this predicate, so a notification cannot be missed. A periodic
    // timeout only wakes a worker that has no work and, over a long session,
    // adds scheduler and thermal pressure for no recovery benefit.
    {
      std::unique_lock<std::mutex> lock(s_pktMutex);
      s_pktCv.wait(lock, [] {
        return s_pktCount > 0 || !s_feederRunning.load(std::memory_order_relaxed);
      });
    }
  }

  MoonlightInstance::ClLogMessage("Audio: feeder thread exiting\n");
}

int MoonlightInstance::AudDecInit(int audioConfiguration, POPUS_MULTISTREAM_CONFIGURATION opusConfig, void* context, int arFlags) {
  // Read the negotiated configuration rather than assuming 240 samples, which
  // is what CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION requires of us
  s_channelCount = static_cast<size_t>(opusConfig->channelCount);
  s_samplesPerFrame = static_cast<size_t>(opusConfig->samplesPerFrame);
  s_sampleRate = opusConfig->sampleRate;

  // Guard the slot pool against a configuration it cannot hold
  if (s_samplesPerFrame * s_channelCount > kMaxFrameElems) {
    ClLogMessage("Audio: frame of %zu samples x %zu channels exceeds slot capacity\n",
                 s_samplesPerFrame, s_channelCount);
    return -1;
  }

  int targetJitterMs = g_Instance->m_AudioJitterMs != 0
    ? g_Instance->m_AudioJitterMs
    : kDefaultJitterMs;
  s_frameDurationMs = static_cast<double>(s_samplesPerFrame) * 1000.0 / s_sampleRate;
  s_jitterFrames = static_cast<int>(std::ceil(targetJitterMs / s_frameDurationMs));

  ClLogMessage("Audio: init ch=%d spf=%d rate=%d frame=%.1fms jitterFrames=%d target=%dms\n",
               opusConfig->channelCount, opusConfig->samplesPerFrame, opusConfig->sampleRate,
               s_frameDurationMs, s_jitterFrames, targetJitterMs);

  // Size the encoded queue from the jitter depth, with a floor so a small
  // jitter setting still absorbs a burst
  s_pktCap = s_jitterFrames * 4;
  if (s_pktCap < 64) {
    s_pktCap = 64;
  }
  s_pktQueue.resize(s_pktCap);
  s_pktHead = s_pktTail = s_pktCount = 0;
  s_lastAudioLogMs.store(0, std::memory_order_relaxed);

  const uint32_t generation =
    s_audioGeneration.fetch_add(1, std::memory_order_acq_rel) + 1;

  // Start with only two Opus frames of protection (normally 20 ms) and allow
  // the audio backend to raise the target in 5 ms steps after a real underrun,
  // never beyond the value selected by the user. This is lower latency than
  // blindly prebuffering the full slider value while remaining self-healing.
  const uint32_t maximumTargetFrames = static_cast<uint32_t>(std::max(
    2.0, std::ceil(targetJitterMs * static_cast<double>(s_sampleRate) / 1000.0)));
  const uint32_t initialTargetFrames = std::min<uint32_t>(
    maximumTargetFrames, static_cast<uint32_t>(s_samplesPerFrame * 2));
  s_pcmRing.Reset(generation, initialTargetFrames, maximumTargetFrames);

  int rc;
  s_OpusDecoder = opus_multistream_decoder_create(
    opusConfig->sampleRate, opusConfig->channelCount,
    opusConfig->streams, opusConfig->coupledStreams,
    opusConfig->mapping, &rc
  );
  if (!s_OpusDecoder) {
    ClLogMessage("Audio: opus_multistream_decoder_create failed rc=%d\n", rc);
    return -1;
  }
  // Configure the pull renderer. The AudioWorklet receives the WASM shared
  // memory object once per stream, then consumes PCM without proxying any audio
  // frames through the main thread.
  MAIN_THREAD_ASYNC_EM_ASM({
    if (typeof configureAudioScheduler === 'function') {
      configureAudioScheduler($0, $1, $2, $3, $4, $5, $6);
    }
  }, targetJitterMs,
     (int)reinterpret_cast<size_t>(s_pcmRing.control()),
     (int)reinterpret_cast<size_t>(s_pcmRing.data()),
     (int)s_pcmRing.capacity_frames(),
     (int)s_channelCount, s_sampleRate, (int)generation);

  s_feederRunning.store(true, std::memory_order_release);
  s_feederThread = std::thread(FeederLoop);

  return 0;
}

void MoonlightInstance::AudDecCleanup(void) {
  // Retire the generation before stopping the feeder, so anything still in
  // flight towards the main thread is recognised as stale on arrival.
  const uint32_t retiring = s_audioGeneration.load(std::memory_order_relaxed);
  s_pcmRing.control()->mode.store(3, std::memory_order_release);
  MAIN_THREAD_ASYNC_EM_ASM({
    if (typeof retireAudioGeneration === 'function') {
      retireAudioGeneration($0);
    }
  }, (int)retiring);

  if (s_feederThread.joinable()) {
    s_feederRunning.store(false, std::memory_order_release);
    s_pktCv.notify_all();
    s_feederThread.join();
  }

  s_pcmRing.control()->generation.store(0, std::memory_order_release);

  MAIN_THREAD_ASYNC_EM_ASM({
    if (typeof stopAudioScheduler === 'function') {
      stopAudioScheduler();
    }
  });

  s_pktQueue.clear();
  s_pktQueue.shrink_to_fit();
  s_pktHead = s_pktTail = s_pktCount = s_pktCap = 0;

  if (s_OpusDecoder) {
    opus_multistream_decoder_destroy(s_OpusDecoder);
    s_OpusDecoder = nullptr;
  }
}

// Runs on the moonlight-common-c audio receive thread for every packet. It only
// copies the still-encoded payload into the ring and returns, which is why
// CAPABILITY_DIRECT_SUBMIT is safe here: there is nothing on this path that can
// stall the socket drain and turn into real packet loss.
void MoonlightInstance::AudDecDecodeAndPlaySample(char* sampleData, int sampleLength) {
  if (!s_feederRunning.load(std::memory_order_relaxed)) {
    return;
  }

  // A length beyond the slot size is corrupt, not lost. Nothing useful can be
  // done with it and concealing it would be a lie about what arrived.
  if (sampleLength > kMaxPacketBytes) {
    LogAudioThrottled("Audio: dropping packet with unusable length");
    return;
  }

  // moonlight-common-c signals a packet the network lost with a null buffer.
  // Queue it as a zero length entry so the feeder runs Opus packet loss
  // concealment for it, in order, rather than silently skipping the frame and
  // leaving a gap in the scheduled audio.
  bool lost = (sampleData == nullptr || sampleLength <= 0);

  {
    std::unique_lock<std::mutex> lock(s_pktMutex);
    if (s_pktCount >= s_pktCap) {
      // Full: discard the oldest, which is the one least worth keeping
      s_pktHead = (s_pktHead + 1) % s_pktCap;
      --s_pktCount;
      LogAudioThrottled("Audio: packet queue overflow, dropping oldest");
    }
    PacketSlot& slot = s_pktQueue[s_pktTail];
    if (lost) {
      slot.length = 0;
    } else {
      memcpy(slot.data, sampleData, static_cast<size_t>(sampleLength));
      slot.length = sampleLength;
    }
    s_pktTail = (s_pktTail + 1) % s_pktCap;
    ++s_pktCount;
  }
  s_pktCv.notify_one();
}

AUDIO_RENDERER_CALLBACKS MoonlightInstance::s_ArCallbacks = {
  .init = MoonlightInstance::AudDecInit,
  .cleanup = MoonlightInstance::AudDecCleanup,
  .decodeAndPlaySample = MoonlightInstance::AudDecDecodeAndPlaySample,
  // DIRECT_SUBMIT is safe because the callback above only does a memcpy.
  //
  // SUPPORTS_ARBITRARY_AUDIO_DURATION plus SLOW_OPUS_DECODER negotiate 10 ms
  // packets. The 10 ms matters beyond halving the packet rate: it doubles the
  // slot pool protection window compared to 5 ms, and it is the duration this
  // design was proven at.
  .capabilities = CAPABILITY_DIRECT_SUBMIT |
                  CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION |
                  CAPABILITY_SLOW_OPUS_DECODER,
};
