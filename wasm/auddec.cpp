#include "moonlight_wasm.hpp"

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
// The path has three stages, none of which can block:
//
//   network thread  ──memcpy encoded packet──►  ring buffer
//   feeder thread   ──decode Opus──►  PCM slot pool  ──MAIN_THREAD_ASYNC_EM_ASM──►
//   main thread     ──_audReceiveFrame()──►  AudioBufferSourceNode
//
// The scheduler on the JS side lives in platform/audio.js.

// Default depth of the jitter buffer when the user has not chosen one. This is
// the setpoint the scheduler's rate servo holds, not a threshold above which
// audio is thrown away; see platform/audio.js.
static constexpr int kDefaultJitterMs = 50;

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

static uint32_t s_lastAudioLogMs = 0;

// Logs at most one line per kAudioLogIntervalMs, dropping the rest
static void LogAudioThrottled(const char* message) {
  uint32_t nowMs = LiGetMillis();
  if (nowMs - s_lastAudioLogMs < kAudioLogIntervalMs) {
    return;
  }
  s_lastAudioLogMs = nowMs;
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

// ─── Decoded frame slot pool ─────────────────────────────────────────────────
// The feeder writes PCM into slot[s_slotIdx % kNumSlots] and hands the pointer
// to the JS scheduler. The pool has to be deep enough that the main thread
// consumes a slot before the feeder wraps around to it again: kNumSlots frames
// is the protection window, so 32 slots at 10 ms is 320 ms of main thread stall
// before a slot could be overwritten while still unread.
// A deep pool alone is not a correctness argument, only a probability one, so
// each slot also carries a version. The feeder makes the version odd before
// writing and even after, and hands the even value to the scheduler along with
// the pointer. The scheduler copies the samples and then re-reads the version:
// if it differs from the one it was given, the feeder wrapped around and
// overwrote the slot mid-copy, and the frame is discarded rather than played as
// a splice of two different moments. That is a seqlock, and it turns a race that
// used to be silently audible into a counted event.
//
// 128 slots at 10 ms is 1.28 s of main thread stall before a slot can be reused,
// which makes the seqlock a backstop rather than a routine occurrence.
static constexpr int kNumSlots = 128;
static constexpr int kMaxFrameElems = 4096; // 480 samples * 8 channels = 3840
static opus_int16 s_frameSlots[kNumSlots][kMaxFrameElems];
alignas(4) static std::atomic<uint32_t> s_slotVersions[kNumSlots];
static int s_slotIdx = 0;

// Incremented for every stream. The scheduler stamps the generation it was
// configured with onto everything it does and ignores frames from any other, so
// a frame published by the previous stream's feeder while teardown was still in
// flight cannot be scheduled against the new stream's clock.
static std::atomic<uint32_t> s_audioGeneration{0};

// Handed to JS once per stream so it can perform the seqlock re-read.
extern "C" EMSCRIPTEN_KEEPALIVE void* audioSlotVersionsAddress() {
  return &s_slotVersions[0];
}

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

      const int slot = s_slotIdx % kNumSlots;
      opus_int16* dst = s_frameSlots[slot];

      // Open the seqlock: an odd version means "being written". What the reader
      // actually relies on is the comparison against the value published below,
      // which detects any rewrite regardless of parity; the odd marker makes a
      // read caught mid-write fail that comparison too.
      s_slotVersions[slot].fetch_add(1, std::memory_order_acq_rel);

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
          dst, static_cast<int>(s_samplesPerFrame), 0
        );
      } else {
        decodeLen = opus_multistream_decode(
          s_OpusDecoder, pktData, pktLen,
          dst, static_cast<int>(s_samplesPerFrame), 0
        );
      }

      if (decodeLen <= 0) {
        // Close the seqlock even on failure, so the slot does not stay marked as
        // being written forever.
        s_slotVersions[slot].fetch_add(1, std::memory_order_release);
        LogAudioThrottled("Audio: Opus decode failed");
        continue;
      }

      // Close the seqlock. The value handed to the scheduler is this even one.
      const uint32_t versionAfter =
        s_slotVersions[slot].fetch_add(1, std::memory_order_acq_rel) + 1;

      // Hand the slot address and format to the main thread scheduler. The JS
      // side reads HEAP16 at this address; shared memory makes that valid
      // across threads, and the slot pool depth bounds the race.
      int slotPtr = static_cast<int>(reinterpret_cast<size_t>(dst));
      int spf = static_cast<int>(s_samplesPerFrame);
      int channels = static_cast<int>(s_channelCount);
      int rate = s_sampleRate;
      int generation = static_cast<int>(s_audioGeneration.load(std::memory_order_relaxed));
      MAIN_THREAD_ASYNC_EM_ASM({
        if (typeof _audReceiveFrame === 'function') {
          _audReceiveFrame($0, $1, $2, $3, $4, $5, $6);
        }
      }, slotPtr, spf, channels, rate, slot, (int)versionAfter, generation);
      s_slotIdx++;
    }

    // Wait for the next packet.
    //
    // The condition variable is signalled on every arriving packet, so the
    // timeout is only a safety net against a missed notification. It used to be
    // one millisecond, which woke this thread a thousand times a second to find
    // nothing and go back to sleep. On a TV with a handful of cores and a dozen
    // threads that is scheduler time taken from the path that delivers video,
    // for no work done.
    {
      std::unique_lock<std::mutex> lock(s_pktMutex);
      s_pktCv.wait_for(lock, std::chrono::milliseconds(20), [] {
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
  s_slotIdx = 0;
  s_lastAudioLogMs = 0;

  // Even versions everywhere: no slot is being written. Starting from zero each
  // stream is safe because the generation below is what separates streams.
  for (int i = 0; i < kNumSlots; i++) {
    s_slotVersions[i].store(0, std::memory_order_relaxed);
  }
  const uint32_t generation =
    s_audioGeneration.fetch_add(1, std::memory_order_acq_rel) + 1;

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
  g_Instance->m_OpusDecoder = s_OpusDecoder;

  // Configure the scheduler for this stream: target depth, the address it needs
  // for the seqlock re-read, and the generation that stamps everything.
  MAIN_THREAD_ASYNC_EM_ASM({
    if (typeof configureAudioScheduler === 'function') {
      configureAudioScheduler($0, $1, $2);
    }
  }, targetJitterMs, (int)reinterpret_cast<size_t>(&s_slotVersions[0]),
     (int)generation);

  s_feederRunning.store(true, std::memory_order_release);
  s_feederThread = std::thread(FeederLoop);

  return 0;
}

void MoonlightInstance::AudDecCleanup(void) {
  // Retire the generation before stopping the feeder, so anything still in
  // flight towards the main thread is recognised as stale on arrival.
  const uint32_t retiring = s_audioGeneration.load(std::memory_order_relaxed);
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
  g_Instance->m_OpusDecoder = nullptr;
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
