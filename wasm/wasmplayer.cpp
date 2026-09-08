#include "moonlight_wasm.hpp"

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <string>
#include <vector>
#include <functional>
#include <mutex>
#include <thread>

#include <emscripten.h>

#include <h264_stream.h>

#include <assert.h>
#include <pthread.h>

#include "samsung/wasm/elementary_audio_track_config.h"
#include "samsung/wasm/elementary_media_packet.h"
#include "samsung/wasm/elementary_video_track_config.h"
#include "samsung/html/html_media_element_listener.h"
#include "samsung/wasm/operation_result.h"

#define INITIAL_DECODE_BUFFER_LEN 1024 * 1024
#define MAX_SPS_EXTRA_SIZE 32

using std::chrono_literals::operator""s;
using std::chrono_literals::operator""ms;
using EmssReadyState = samsung::wasm::ElementaryMediaStreamSource::ReadyState;
using EmssOperationResult = samsung::wasm::OperationResult;
using EmssAsyncResult = samsung::wasm::OperationResult;
using HTMLAsyncResult = samsung::wasm::OperationResult;
using TimeStamp = samsung::wasm::Seconds;

// Largest jump in frame number still treated as ordinary packet loss. Beyond
// this the timeline is re-anchored instead of extrapolated: a gap that long is
// a restart or a renumbering, and stepping through it would push the timeline
// seconds into the future.
static constexpr int kMaxFrameNumberGap = 120;

// Frames over which the delivered frame rate is averaged to derive the step.
//
// The host does not deliver the rate that was requested. Measured on hardware it
// delivers 56 FPS with a still picture and 59.1 FPS in motion, because capture
// skips frames that did not change. A timeline that advances at a nominal 60
// while 56 arrive claims a cadence the stream cannot sustain, and the pipeline
// runs out of picture several times a second.
//
// So the step is measured rather than assumed: total host time divided by total
// frames over a window. That is unbiased by construction, whatever the host is
// doing, and averaging a window of this size takes the host clock's millisecond
// quantisation down to about a twentieth of a millisecond, which is what the
// generated timeline was introduced to avoid in the first place.
//
// An earlier design tried to correct a nominal step towards the host with a
// capped adjustment. The cap was fifty microseconds and the correction actually
// needed ranges from 250 microseconds at 59.1 FPS to 1190 at 56, so it saturated
// and never converged.
static constexpr int kPtsRateWindowFrames = 64;

// Sanity bounds on the measured step, as a multiple of the nominal frame
// duration. A window that produces anything outside this is not a frame rate.
static constexpr double kPtsStepMinFactor = 0.5;
static constexpr double kPtsStepMaxFactor = 2.0;

// Stages of the H.264 SPS fixup, so a decoder that dislikes one of them can be
// bisected by lowering this rather than by rebuilding with parts commented out.
//   0 = off, the bitstream is passed through untouched
//   1 = declare the bitstream restrictions: no reordering, one buffered frame
//   2 = also cap the reference frame count at one
//   3 = also lower level_idc to the smallest level that fits the resolution
static constexpr int kSpsFixupStage = 3;

// Minimum interval between IDR requests triggered by append failures. A
// keyframe costs several times a P-frame, so one request per rejected packet
// turns a congested link into a worse one.
static constexpr uint32_t kIdrRequestIntervalMs = 500;

// ─── Presentation stall detection ────────────────────────────────────────────
//
// The failure this catches has a specific signature: the platform keeps
// accepting packets, so nothing upstream reports a problem, while the picture
// and the reported playback position both stop advancing. Everything looks
// healthy from the submission side and the screen is frozen.
//
// The detector only arms once the platform has proved that it reports position
// at all and that the position was advancing, because those two facts are what
// make a lack of movement meaningful rather than merely unobserved.
//
// The threshold cannot be a fixed number, because the reporting interval is not
// documented and is not ours to choose. A platform that reports once a second
// leaves the position legitimately unchanged for a second at a time, and a fixed
// 750 ms threshold would then declare a stall on every reporting interval and
// flush the pipeline forever: the protection would become the fault. So the
// threshold calibrates itself against the largest gap actually observed while
// presentation was known to be advancing, and only a gap several times longer
// than anything healthy counts.
static constexpr uint32_t kStallFloorMs = 1500;
static constexpr uint32_t kStallHealthyGapMultiple = 4;
static constexpr uint32_t kStallMinAppendsWithoutProgress = 30;
static constexpr uint32_t kStallRecoveryCooldownMs = 3000;

// ─── Timeline anchoring ──────────────────────────────────────────────────────
//
// The generated timeline is an accumulator: each frame's timestamp is the
// previous one plus a step. Nothing re-anchors it to the platform once the
// stream is running, and that is a problem in two different ways.
//
// The step is measured from the *host's* clock; the pipeline plays on the
// *TV's*. Two independent crystals differ by tens of parts per million, and the
// difference integrates without bound. Ten to fifteen ppm is ordinary, and it
// exhausts a twenty millisecond buffer in half an hour - which is a stall, a
// recovery, and a visible jump. Then it starts over.
//
// A flush does not help: it empties the platform's queue but leaves the
// accumulator exactly where it was, so the offset survives every recovery and
// each cycle begins worse than the last. That is what turns one glitch into an
// unplayable stream that only restarting clears.

// Where the timeline is placed relative to the platform's reported position
// when it is re-anchored after a flush. Slightly ahead is the safe side: frames
// wait a moment. Behind, they arrive already due and may be dropped outright.
static constexpr double kReanchorLeadMs = 30.0;

// The lead is measured per frame but the position underneath it only updates
// about once a second, so single samples are extrapolation, not observation.
// This averages over roughly seventeen seconds at 60 fps, which is far shorter
// than the drift being corrected and far longer than the noise being rejected.
static constexpr double kLeadFilterAlpha = 1.0 / 1024.0;

// Samples to collect before the filtered lead is trusted, and before the
// operating point is taken from it. Thirty seconds: long enough that the value
// describes the running stream rather than its first moments.
static constexpr int kLeadSettleSamples = 1800;

// The operating point is learned rather than assumed, because how much the
// pipeline holds is the platform's business and differs by model. It is clamped
// only to reject a value that could not describe a working stream.
static constexpr double kLeadTargetMinMs = 2.0;
static constexpr double kLeadTargetMaxMs = 200.0;

// The correction does nothing until the lead has strayed further than the noise
// floor. Measured deviation on a healthy stream is around five milliseconds, so
// eight keeps the loop inert in normal operation - it acts on drift, not jitter.
static constexpr double kLeadDeadbandMs = 8.0;

// Ceiling on how far one frame's timestamp may be moved. Three hundredths of a
// millisecond is two tenths of one percent of a frame, far below anything that
// can be seen, and still three milliseconds per second of authority - fifty
// times what fifteen ppm of clock drift produces. It cannot saturate the way
// the old step-correction did, and it cannot produce a visible step either.
static constexpr double kLeadCorrectionPerFrameMs = 0.05;

static uint32_t s_VideoFormat = 0;
static uint32_t s_Width = 0;
static uint32_t s_Height = 0;
static uint32_t s_Framerate = 0;

static std::vector<unsigned char> s_DecodeBuffer;

static TimeStamp s_frameDuration;
static TimeStamp s_pktPts;

// Generated timeline state, see NextPacketPts()
static uint32_t s_lastHostPtsMs = 0;
static bool s_hasHostPtsRef = false;
static bool s_loggedPtsSource = false;

// Uniform step, re-measured once per window from the host's own clock.
static TimeStamp s_ptsStep;
static int s_ptsFrameNumberRef = 0;

// Window the step is measured over: host time and frame count at its start.
static uint32_t s_ptsWindowHostMs = 0;
static int s_ptsWindowFrames = 0;

// Set by the recovery worker after it flushes, consumed by the submission
// thread on its next frame. Crossing threads through the timestamp itself would
// mean writing the accumulator from two places; a request that the owner acts on
// keeps it single-writer.
static std::atomic<bool> s_ptsReanchorRequested{false};

// Filtered distance between the timeline and where the platform says it is,
// with the operating point learned from it once it has settled.
static double s_leadFilteredMs = 0.0;
static int s_leadSamples = 0;
static double s_leadTargetMs = 0.0;
static bool s_leadTargetSet = false;

// One-shot log guard for the pipeline clock, so its absence is visible in the
// log by omission rather than its presence being repeated every update.
static bool s_loggedPipelineClock = false;

// One-shot log guard for the SPS rewrite, which happens once per IDR frame.
static bool s_loggedSpsFixup = false;

// Cadence instrumentation. The interval between successive appends is the one
// thing we can measure without the platform's cooperation, and its spread is
// what a frame rate average hides.
static std::chrono::time_point<std::chrono::steady_clock> s_lastAppendTime;
static bool s_hasLastAppendTime = false;

// Diagnostic cadence thresholds scale with the requested rate so the overlay
// remains meaningful on 30, 50, 60 and 120 Hz streams. A quarter-frame miss is
// the point where a delivery error becomes visible without treating ordinary
// timer noise as a hitch.
static constexpr double kCadenceToleranceFrames = 0.25;
static constexpr uint32_t kStatsUpdateMs = 2000;

static uint32_t s_lastIdrRequestMs = 0;

// Reused formatting buffer for the once-per-second optional stats update.
static std::string s_PendingStatMsg;

static uint32_t total_bytes = 0;
static int m_LastFrameNumber = 0;

static std::string s_StatString = "";

// Defined below, next to the recovery worker they control.
static void StartRecoveryThread();
static void StopRecoveryThread();

static VIDEO_STATS m_ActiveWndVideoStats;
static VIDEO_STATS m_LastWndVideoStats;
static mltelemetry::HitchTracker s_HitchTracker;
// Owned by the decoder thread. This makes enabling the overlay start a clean
// measurement window without keeping dormant counters hot during normal play.
static bool s_collectingStats = false;

static uint64_t SteadyUs(
  std::chrono::time_point<std::chrono::steady_clock> time
) {
  return static_cast<uint64_t>(
    std::chrono::duration_cast<std::chrono::microseconds>(
      time.time_since_epoch()).count());
}

static uint32_t ToMicroseconds(double milliseconds) {
  if (milliseconds <= 0.0) {
    return 0;
  }
  const double microseconds = milliseconds * 1000.0;
  return static_cast<uint32_t>(std::min<double>(microseconds, UINT32_MAX));
}

MoonlightInstance::SourceListener::SourceListener(
  MoonlightInstance* instance
) : m_Instance(instance) {}

void MoonlightInstance::SourceListener::OnSourceOpen() {
  ClLogMessage("EMSS::OnOpen\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_EmssReadyState = EmssReadyState::kOpen;
  m_Instance->m_EmssStateChanged.notify_all();
}

void MoonlightInstance::SourceListener::OnSourceOpenPending() {
  ClLogMessage("EMSS::OnOpenPending\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_EmssReadyState = EmssReadyState::kOpenPending;
  m_Instance->m_EmssStateChanged.notify_all();
}

void MoonlightInstance::SourceListener::OnSourceClosed() {
  ClLogMessage("EMSS::OnClosed\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_EmssReadyState = EmssReadyState::kClosed;
  m_Instance->m_EmssStateChanged.notify_all();
}

// Records where the pipeline says it is. Deliberately does nothing else: this
// runs on the main thread, and the frame path must never wait on it. It only
// publishes two numbers that the decoder thread reads without locking.
void MoonlightInstance::SourceListener::OnPlaybackPositionChanged(
  samsung::wasm::Seconds position
) {
  auto positionUs = static_cast<int64_t>(position.count() * 1000000.0);

  // A pipeline that has not started yet can legitimately report zero; that is a
  // real measurement and must be kept. Only a negative value would be nonsense,
  // and it would collide with the "not reported yet" sentinel.
  if (positionUs < 0) {
    return;
  }

  // Order matters: publish the timestamp first, then the position. A reader
  // that catches the pair mid-update then extrapolates from a slightly stale
  // timestamp, which overstates the position by microseconds. The reverse order
  // would pair a new timestamp with an old position and understate it by a
  // whole reporting interval.
  m_Instance->m_PipelinePositionAtMs.store(LiGetMillis(), std::memory_order_relaxed);
  m_Instance->m_PipelinePositionUs.store(positionUs, std::memory_order_release);

  // The audio scheduler needs a video clock to servo against, and this is a
  // better one than the media element's currentTime: Samsung documents it as the
  // preferred source of time updates. Published asynchronously so this callback
  // never waits, and with the position in milliseconds because that is the
  // precision the drift loop works at.
  MAIN_THREAD_ASYNC_EM_ASM({
    if (typeof publishPipelinePosition === 'function') {
      publishPipelinePosition($0);
    }
  }, (int)(positionUs / 1000));

  if (!s_loggedPipelineClock) {
    s_loggedPipelineClock = true;
    ClLogMessage("Pipeline is reporting its playback position\n");
  }
}

// There is no audio track listener: audio does not go through the EMSS at all,
// it is rendered by the Web Audio scheduler in platform/audio.js. The media
// source below carries video only.

MoonlightInstance::VideoTrackListener::VideoTrackListener(
  MoonlightInstance* instance
) : m_Instance(instance) {}

void MoonlightInstance::VideoTrackListener::OnTrackOpen() {
  ClLogMessage("VIDEO ElementaryMediaTrack::OnTrackOpen\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_VideoStarted = true;
  m_Instance->m_EmssVideoStateChanged.notify_all();
  LiRequestIdrFrame();
}

void MoonlightInstance::VideoTrackListener::OnTrackClosed(samsung::wasm::ElementaryMediaTrack::CloseReason) {
  ClLogMessage("VIDEO ElementaryMediaTrack::OnTrackClosed\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_VideoStarted = false;
}

void MoonlightInstance::VideoTrackListener::OnSessionIdChanged(samsung::wasm::SessionId new_session_id) {
  ClLogMessage("VIDEO ElementaryMediaTrack::OnSessionIdChanged\n");
  std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
  m_Instance->m_VideoSessionId.store(new_session_id);
}

void MoonlightInstance::DidChangeFocus(bool got_focus) {
  // Request an IDR frame to dump the frame queue that may have
  // built up from the GL pipeline being stalled.
  if (got_focus) {
    LiRequestIdrFrame();
  }
}

bool MoonlightInstance::InitializeRenderingSurface(int width, int height) {
  return true;
}

int MoonlightInstance::StartupVidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags) {
  // Bind the media source to the media element
  g_Instance->m_MediaElement.SetSrc(g_Instance->m_Source.get());
  ClLogMessage("Waiting to close\n");

  g_Instance->WaitFor(&g_Instance->m_EmssStateChanged, [] {
    return g_Instance->m_EmssReadyState == EmssReadyState::kClosed;
  });
  if (g_Instance->m_ConnectionCancelled) {
    ClLogMessage("Connection cancelled during initial close wait\n");
    return -1;
  }
  ClLogMessage("Closed\n");

  // No audio track is added here on purpose. Audio is rendered by the Web Audio
  // scheduler, so this source carries video only.

  {
    // Candidate track configurations, most preferred first. More than one entry
    // exists only where a lower declared level is worth trying, and every list
    // ends with the configuration that has always worked, so a decoder that
    // rejects the preferred form falls back instead of failing to start.
    std::vector<std::string> mimetypes;

    if (videoFormat & VIDEO_FORMAT_H264) {
      // H.264 High Profile 4.2. A TV may support higher, e.g. 5.1 (avc1.640033).
      mimetypes.push_back("video/mp4; codecs=\"avc1.64002A\"");
    } else if (videoFormat & (VIDEO_FORMAT_H265 | VIDEO_FORMAT_H265_MAIN10)) {
      // The profile prefix differs between Main and Main10; the tier and level
      // that follow do not.
      const char* profile = (videoFormat & VIDEO_FORMAT_H265_MAIN10)
        ? "hev1.2.4." : "hev1.1.6.";

      // Declaring a level sizes the decoder's picture buffer, and we have been
      // declaring the 4K one regardless of what we actually stream.
      //
      // HEVC derives the buffer from the level's MaxLumaPs and the real picture
      // size (H.265 A.4.2). At 1080p under level 5.1, MaxLumaPs is 8912896 and
      // the picture is 2073600, which lands in the first bracket and yields a
      // buffer of 16 pictures. Under level 4.1, MaxLumaPs is 2228224, the
      // picture lands in the last bracket, and the buffer is 6. The decoder has
      // been provisioning, and potentially filling, more than twice the frames
      // it needs before it shows one.
      //
      // This is the same reasoning behind the level_idc patching in
      // moonlight-android, obtained here without rewriting the bitstream.
      //
      // Only worth doing below 1440p: above that the picture no longer fits the
      // smaller level at all, and level 5.0 and 5.1 produce the same buffer.
      if ((uint64_t)width * (uint64_t)height <= 1920ull * 1080ull) {
        // High tier first: level 4.1 Main tier caps at 20 Mbps, which is exactly
        // the 1080p60 preset, leaving a stream configured any higher against the
        // ceiling. High tier at the same level allows 50 Mbps.
        mimetypes.push_back(std::string("video/mp4; codecs=\"") + profile + "H123.B0\"");
        mimetypes.push_back(std::string("video/mp4; codecs=\"") + profile + "L123.B0\"");
      }

      // Level 5.1, the configuration used up to v2.1.0. Always last.
      mimetypes.push_back(std::string("video/mp4; codecs=\"") + profile + "L153.B0\"");
    } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN8) {
      // AV1 Main Level 5.1. A TV may support higher, e.g. 5.2 (av01.0.14M.08).
      mimetypes.push_back("video/mp4; codecs=\"av01.0.13M.08\"");
    } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN10) {
      // AV1 Main10 Level 5.1. A TV may support higher, e.g. 5.2 (av01.0.14M.10).
      mimetypes.push_back("video/mp4; codecs=\"av01.0.13M.10\"");
    } else {
      ClLogMessage("Failed to select video codec profile (videoFormat=0x%x)\n", videoFormat);
      return -1;
    }

    bool trackAdded = false;
    for (const std::string& mimetype : mimetypes) {
      ClLogMessage("Trying mimeType %s\n", mimetype.c_str());

      auto add_track_result = g_Instance->m_Source->AddTrack(
        samsung::wasm::ElementaryVideoTrackConfig {
          mimetype, // MIME-type: Selected Video Format
          {}, // Extradata: Empty
          samsung::wasm::DecodingMode::kHardware, // Decoding mode: Hardware
          static_cast<uint32_t>(width), // Video resolution: Width
          static_cast<uint32_t>(height), // Video resolution: Height
          static_cast<uint32_t>(redrawRate), // Framerate: Numerator
          1, // Framerate: Denominator
        }
      );

      if (add_track_result) {
        g_Instance->m_VideoTrack = std::move(*add_track_result);
        g_Instance->m_VideoTrack.SetListener(&g_Instance->m_VideoTrackListener);
        ClLogMessage("Using mimeType %s\n", mimetype.c_str());
        trackAdded = true;
        break;
      }

      ClLogMessage("Track rejected, falling back\n");
    }

    // Previously a failure here was ignored and setup carried on without a
    // track, which turns a clear error into a stream that opens and shows
    // nothing.
    if (!trackAdded) {
      ClLogMessage("No usable video track configuration was accepted\n");
      return -1;
    }
  }

  ClLogMessage("Inb4 source open\n");
  g_Instance->m_Source->Open([](EmssOperationResult){});
  g_Instance->WaitFor(&g_Instance->m_EmssStateChanged, [] {
    return g_Instance->m_EmssReadyState == EmssReadyState::kOpenPending || 
           g_Instance->m_EmssReadyState == EmssReadyState::kOpen;
  });
  if (g_Instance->m_ConnectionCancelled) {
    ClLogMessage("Connection cancelled during open wait\n");
    return -1;
  }

  ClLogMessage("Source ready to open\n");
  g_Instance->m_MediaElement.Play([](EmssOperationResult err) {
    if (err != EmssOperationResult::kSuccess) {
      ClLogMessage("Play error\n");
    } else {
      ClLogMessage("Play success\n");
    }
  });

  ClLogMessage("Waiting for the video track to open\n");
  g_Instance->WaitFor(&g_Instance->m_EmssVideoStateChanged, [] {
    return g_Instance->m_VideoStarted.load();
  });
  if (g_Instance->m_ConnectionCancelled) {
    ClLogMessage("Connection cancelled during video wait\n");
    return -1;
  }

  ClLogMessage("Started\n");
  return 0;
}

int MoonlightInstance::VidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags) {
  ClLogMessage("Video decoding setup has started.\n");

  // Resize the decode buffer based on initial decode buffer length
  s_DecodeBuffer.resize(INITIAL_DECODE_BUFFER_LEN);

  // Set the video format, video resolution and video frame rate based on the input parameters
  s_VideoFormat = videoFormat;
  s_Width = width;
  s_Height = height;
  s_Framerate = redrawRate;

  // Calculate frame duration from the frame rate
  s_frameDuration = TimeStamp(1.0 / (float)redrawRate);

  // Initialize packet timestamp to zero
  s_pktPts = 0s;

  // Reset the generated timeline for the new stream
  s_hasHostPtsRef = false;
  s_lastHostPtsMs = 0;
  s_loggedPtsSource = false;
  s_ptsStep = s_frameDuration;
  s_ptsFrameNumberRef = 0;
  s_ptsWindowHostMs = 0;
  s_ptsWindowFrames = 0;
  s_ptsReanchorRequested.store(false, std::memory_order_relaxed);
  s_leadFilteredMs = 0.0;
  s_leadSamples = 0;
  s_leadTargetMs = 0.0;
  s_leadTargetSet = false;

  // Reset the IDR request throttle for the new stream
  s_lastIdrRequestMs = 0;

  // Reset the cadence instrumentation. The first append of a stream has no
  // predecessor to measure against, and the pipeline of the previous stream has
  // nothing to say about this one.
  s_hasLastAppendTime = false;
  s_loggedPipelineClock = false;
  s_loggedSpsFixup = false;
  g_Instance->m_PipelinePositionUs.store(kNoPipelinePosition, std::memory_order_release);
  g_Instance->m_PipelinePositionAtMs.store(0, std::memory_order_relaxed);

  // Preallocate space for the performance stats string. The cadence block added
  // several lines, and FormatVideoStats() asserts rather than truncating.
  s_StatString.resize(2400);

  // Drop any stats message left pending from a previous stream
  s_PendingStatMsg.clear();

  // Reset the stats counters that live outside the VIDEO_STATS structures.
  // Leaving m_LastFrameNumber set from a previous session makes the dropped
  // frame arithmetic below underflow on the first frame of the next one.
  total_bytes = 0;
  m_LastFrameNumber = 0;

  // Clear active window video statistics to start fresh
  memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));

  // Clear last window video statistics from previous session
  memset(&m_LastWndVideoStats, 0, sizeof(m_LastWndVideoStats));
  s_collectingStats = false;

  // The recovery worker has to exist before the first frame can be appended,
  // because the detector runs on the append path.
  StartRecoveryThread();

  // Ensure that StartupVidDecSetup is called every time when VidDecSetup is invoked to reinitialize the media pipeline
  int initVidDec = StartupVidDecSetup(videoFormat, width, height, redrawRate, context, drFlags);

  // Check and handle errors from video decoding configuration and propagating failures
  if (initVidDec != 0) {
    ClLogMessage("Initialization of video decoding configuration failed: %d\n", initVidDec);
    // Cleanup is not guaranteed to run for a setup that never succeeded, so the
    // worker started above has to be retired here.
    StopRecoveryThread();
    return initVidDec;
  }

  return DR_OK;
}

// Rewrites an H.264 SPS so the decoder provisions for a low delay stream.
//
// The stream is always low delay: the host emits I and P frames only, never
// reorders, and keeps a single reference. The SPS it sends does not say so. A
// hardware decoder reading an SPS with no bitstream restrictions does what the
// standard requires and assumes reordering is possible, so it sizes its picture
// buffer from level_idc and holds several frames before emitting the first. That
// is latency, and worse, it is latency that changes size when the network
// wobbles, which is what a viewer perceives as uneven motion.
//
// moonlight-android performs the same rewrite on every device since Android 8
// (MediaCodecDecoderRenderer.java), with the note that it "at worst seems to do
// nothing and at best fixes issues with video lag, hangs, and crashes".
//
// h264bitstream handles the emulation prevention bytes in both directions, which
// is the part that is genuinely awkward to do by hand. Returns the number of
// bytes written to `out`, or 0 to mean "use the original".
static unsigned int FixupSps(const uint8_t* nalu, unsigned int naluLen,
                             uint8_t* out, unsigned int outCapacity) {
  if (kSpsFixupStage <= 0 || naluLen < 5) {
    return 0;
  }

  // Locate the Annex B start code so the NAL header can be handed to the parser
  // at the right offset. Both three and four byte forms occur.
  unsigned int startLen;
  if (nalu[0] == 0x00 && nalu[1] == 0x00 && nalu[2] == 0x01) {
    startLen = 3;
  } else if (naluLen >= 6 && nalu[0] == 0x00 && nalu[1] == 0x00 &&
             nalu[2] == 0x00 && nalu[3] == 0x01) {
    startLen = 4;
  } else {
    return 0;
  }

  h264_stream_t* h = h264_new();
  if (h == nullptr) {
    return 0;
  }

  unsigned int written = 0;
  do {
    if (read_nal_unit(h, const_cast<uint8_t*>(nalu) + startLen,
                      (int)(naluLen - startLen)) < 0) {
      break;
    }
    if (h->nal->nal_unit_type != 7 || h->sps == nullptr) {
      break;  // not an SPS after all
    }

    sps_t* sps = h->sps;

    // Stage 1. The VUI is where the restrictions live, so it has to exist.
    sps->vui_parameters_present_flag = 1;
    sps->vui.bitstream_restriction_flag = 1;
    sps->vui.num_reorder_frames = 0;
    sps->vui.motion_vectors_over_pic_boundaries_flag = 1;
    sps->vui.max_bytes_per_pic_denom = 2;
    sps->vui.max_bits_per_mb_denom = 1;
    sps->vui.log2_max_mv_length_horizontal = 16;
    sps->vui.log2_max_mv_length_vertical = 16;

    // Stage 2. One reference frame is all the stream uses. Some decoders reject
    // a max_dec_frame_buffering below num_ref_frames, so the two move together.
    if (kSpsFixupStage >= 2) {
      sps->num_ref_frames = 1;
    }
    sps->vui.max_dec_frame_buffering = sps->num_ref_frames;

    // Stage 3. Decoders that size their buffer from the declared level benefit
    // from the smallest level that still fits. The thresholds match the ones in
    // moonlight-android.
    if (kSpsFixupStage >= 3) {
      if (s_Width <= 720 && s_Height <= 480 && s_Framerate <= 60) {
        sps->level_idc = 31;
      } else if (s_Width <= 1280 && s_Height <= 720 && s_Framerate <= 60) {
        sps->level_idc = 32;
      } else if (s_Width <= 1920 && s_Height <= 1080 && s_Framerate <= 60) {
        sps->level_idc = 42;
      }
      // Above 1080p, or above 60 Hz, leave the level as the host sent it
    }

    int rc = write_nal_unit(h, out + startLen, (int)(outCapacity - startLen));
    if (rc <= 0) {
      break;
    }

    memcpy(out, nalu, startLen);
    written = startLen + (unsigned int)rc;
  } while (false);

  h264_free(h);
  return written;
}

// Derives the presentation timestamp for the frame about to be submitted.
//
// The timestamp handed to the pipeline has to satisfy two things that pull in
// opposite directions: the interval between consecutive frames must be uniform,
// because that interval is the cadence the display will reproduce; and the
// timeline must not drift against the host, because that is what keeps video
// aligned with audio over a long session.
//
// Reading the host clock directly, as the previous implementation did, gets the
// second and destroys the first. moonlight-common-c derives presentationTimeMs
// from the 90 kHz RTP timestamp with an integer division by 90
// (RtpVideoQueue.c). At 60 FPS a frame is exactly 1500 ticks, and 1500/90 is
// 16.666..., so the sequence that arrives is 0, 16, 33, 50, 66, 83, ... and the
// deltas repeat 16, 17, 17. Following those deltas injects a periodic third of
// a millisecond of error into every frame's presentation time, and into the
// pacer deadline derived from it. A repeating pattern of timing error is far
// more visible than random jitter of the same size.
//
// So the timeline is generated instead of copied. It advances by a step that
// stays within a few microseconds of the nominal frame duration, and that step
// is slowly adapted so the accumulated timeline tracks the host's accumulated
// time. Uniform output, locked rate.
//
// How many frames to advance comes from the frame number rather than from the
// timestamp: it is an exact integer, so a frame lost on the network still moves
// the timeline by the right amount without reintroducing the quantisation the
// rest of this function exists to remove.
static TimeStamp NextPacketPts(PDECODE_UNIT decodeUnit, TimeStamp previousPts) {
  uint32_t hostMs = decodeUnit->presentationTimeMs;
  int frameNumber = decodeUnit->frameNumber;

  if (!s_hasHostPtsRef) {
    s_hasHostPtsRef = true;
    s_lastHostPtsMs = hostMs;
    s_ptsFrameNumberRef = frameNumber;
    s_ptsWindowHostMs = hostMs;
    s_ptsWindowFrames = 0;
    s_ptsStep = s_frameDuration;
    // Anchor the timeline at zero, as every previous implementation did, so the
    // baseline offset against the audio track is unchanged.
    return TimeStamp(0);
  }

  // A flush emptied the platform's queue while this accumulator kept running.
  // Anchoring onto the position the platform is actually at is the whole point
  // of the exercise: without it the recovery discards frames and changes
  // nothing, and the next stall arrives sooner than the last.
  if (s_ptsReanchorRequested.exchange(false, std::memory_order_acq_rel)) {
    const int64_t positionUs =
      g_Instance->m_PipelinePositionUs.load(std::memory_order_acquire);

    s_lastHostPtsMs = hostMs;
    s_ptsFrameNumberRef = frameNumber;
    s_ptsWindowHostMs = hostMs;
    s_ptsWindowFrames = 0;

    // The operating point described the stream before the flush. Whatever it is
    // afterwards has to be measured again rather than carried across.
    s_leadSamples = 0;
    s_leadTargetSet = false;

    if (positionUs != MoonlightInstance::kNoPipelinePosition) {
      // The position is only reported about once a second, so the stored value
      // can be most of a second old. Anchoring onto it raw would place the
      // timeline that far into the past, and frames would arrive already due -
      // which is the failure this is supposed to prevent, not cause. Advance it
      // to now at real time, exactly as the lead measurement does.
      const uint64_t reportedAtMs =
        g_Instance->m_PipelinePositionAtMs.load(std::memory_order_relaxed);
      const uint64_t nowMs = LiGetMillis();
      const double sinceReportMs =
        (nowMs >= reportedAtMs) ? (double)(nowMs - reportedAtMs) : 0.0;

      const double anchorS =
        positionUs / 1000000.0 + (sinceReportMs + kReanchorLeadMs) / 1000.0;

      MoonlightInstance::ClLogMessage(
        "Re-anchoring the video timeline onto the pipeline clock at %.3f s\n",
        anchorS);
      return TimeStamp(anchorS);
    }

    // Nothing to anchor onto. Carrying on unchanged is no worse than before.
    return previousPts + s_ptsStep;
  }

  int framesElapsed = frameNumber - s_ptsFrameNumberRef;
  s_ptsFrameNumberRef = frameNumber;

  // A frame number that did not advance, ran backwards, or jumped further than a
  // brief loss burst means the stream restarted or the host reset its numbering.
  // The window measures nothing across that boundary, so it starts again.
  if (framesElapsed < 1 || framesElapsed > kMaxFrameNumberGap) {
    s_lastHostPtsMs = hostMs;
    s_ptsWindowHostMs = hostMs;
    s_ptsWindowFrames = 0;
    s_ptsStep = s_frameDuration;
    return previousPts + s_frameDuration;
  }

  // Fold this frame's host interval into the cadence statistics before the
  // window arithmetic consumes it. This is the host's own spacing, independent
  // of anything that happens to the frame afterwards, and it is the only way to
  // tell an unevenly delivered stream from one this client made uneven.
  if (g_Instance->PerformanceStatsEnabled()) {
    double hostDeltaMs =
      (double)((int64_t)hostMs - (int64_t)s_lastHostPtsMs) / framesElapsed;
    double frameMs = std::chrono::duration<double, std::milli>(s_frameDuration).count();
    if (hostDeltaMs > 0.0 && hostDeltaMs < frameMs * 4) {
      m_ActiveWndVideoStats.hostIntervalCount++;
      m_ActiveWndVideoStats.hostIntervalSumMs += hostDeltaMs;
      m_ActiveWndVideoStats.hostIntervalSumSqMs += hostDeltaMs * hostDeltaMs;
      mltelemetry::Add(m_ActiveWndVideoStats.hostIntervalsUs,
                       ToMicroseconds(hostDeltaMs));
      if (hostDeltaMs > frameMs * (1.0 + kCadenceToleranceFrames)) {
        m_ActiveWndVideoStats.hostLateIntervals++;
      }
    }
  }
  s_lastHostPtsMs = hostMs;

  s_ptsWindowFrames += framesElapsed;

  // Re-measure the step once the window is full: total host time over total
  // frames. Nothing here assumes what the rate should be.
  if (s_ptsWindowFrames >= kPtsRateWindowFrames) {
    int64_t spanMs = (int64_t)hostMs - (int64_t)s_ptsWindowHostMs;
    if (spanMs > 0) {
      double measuredS = (double)spanMs / 1000.0 / (double)s_ptsWindowFrames;
      double nominalS = s_frameDuration.count();
      if (measuredS >= nominalS * kPtsStepMinFactor &&
          measuredS <= nominalS * kPtsStepMaxFactor) {
        s_ptsStep = TimeStamp(measuredS);

        if (!s_loggedPtsSource) {
          s_loggedPtsSource = true;
          MoonlightInstance::ClLogMessage(
            "Video timeline is following the delivered frame rate (%.2f FPS)\n",
            1.0 / measuredS);
        }
      }
    }
    // A host that never fills the timestamp leaves spanMs at zero, and the step
    // simply stays nominal, which is the right thing to do knowing nothing.
    s_ptsWindowHostMs = hostMs;
    s_ptsWindowFrames = 0;
  }

  // Hold the timeline against the platform's clock. The step above tracks the
  // host's *rate*; this corrects the accumulated *offset*, which the step alone
  // can never see. Inert unless the lead has strayed past the noise floor, and
  // capped so far below a frame that a correction cannot be seen even when it
  // runs continuously.
  double correctionMs = 0.0;
  if (s_leadTargetSet) {
    const double errorMs = s_leadFilteredMs - s_leadTargetMs;
    if (errorMs > kLeadDeadbandMs) {
      correctionMs = -kLeadCorrectionPerFrameMs * framesElapsed;
    } else if (errorMs < -kLeadDeadbandMs) {
      correctionMs = kLeadCorrectionPerFrameMs * framesElapsed;
    }
  }

  return previousPts + s_ptsStep * framesElapsed + TimeStamp(correctionMs / 1000.0);
}

// Folds the interval since the previous append into the window statistics.
//
// Measured around AppendPacket rather than around the pacer, because this is
// the last moment we control. Whatever the pipeline does afterwards, an uneven
// cadence here can only make it worse.
void MoonlightInstance::RecordAppendCadence(VIDEO_STATS& stats) {
  auto now = std::chrono::steady_clock::now();

  if (s_hasLastAppendTime) {
    double intervalMs =
      std::chrono::duration<double, std::milli>(now - s_lastAppendTime).count();
    double frameMs = std::chrono::duration<double, std::milli>(s_frameDuration).count();
    const double toleranceMs = frameMs * kCadenceToleranceFrames;

    // Keep ordinary microstutter and short stalls in the distribution. A gap
    // beyond a second is a stream transition, debugger stop or suspension and
    // has no useful cadence percentile.
    if (intervalMs > 0.0 && intervalMs < 1000.0) {
      stats.appendIntervalCount++;
      stats.appendIntervalSumMs += intervalMs;
      stats.appendIntervalSumSqMs += intervalMs * intervalMs;
      mltelemetry::Add(stats.appendIntervalsUs, ToMicroseconds(intervalMs));

      const bool late = intervalMs > frameMs + toleranceMs;
      const bool early = intervalMs < frameMs - toleranceMs;
      if (late || early) {
        stats.appendJitterOutliers++;
      }
      if (late) {
        stats.appendLateIntervals++;
      } else if (early) {
        stats.appendEarlyIntervals++;
      }
      mltelemetry::Observe(s_HitchTracker, late, SteadyUs(now));
    } else {
      mltelemetry::Observe(s_HitchTracker, false, SteadyUs(now));
    }
  }

  s_lastAppendTime = now;
  s_hasLastAppendTime = true;
}

// Folds the distance between the timestamp just submitted and where the
// pipeline reports it is.
//
// This is the number that decides the next round of work. If the lead stays
// near zero, the pipeline presents what we hand it more or less on arrival, and
// the submission cadence is the presentation cadence. If the lead settles at
// some depth, the pipeline is buffering and scheduling by PTS, which means
// pacing the submission cannot control presentation at all, and the effort
// belongs somewhere else entirely.
void MoonlightInstance::RecordPipelineLead(
  VIDEO_STATS& stats, TimeStamp framePts, bool collectStats,
  int64_t positionUs, uint64_t reportedAtMs, uint32_t nowMs
) {
  if (positionUs == kNoPipelinePosition) {
    // The platform never reported. Leaving the counters at zero makes that
    // visible in the overlay rather than silently reporting a lead of zero,
    // which would look like a measurement.
    return;
  }

  // Extrapolate the reported position to now at real time. Playback rate is
  // never altered here, so 1:1 is exact between updates.
  double sinceReportMs = (nowMs >= reportedAtMs) ? (double)(nowMs - reportedAtMs) : 0.0;
  double positionMs = (positionUs / 1000.0) + sinceReportMs;

  double framePtsMs = std::chrono::duration<double, std::milli>(framePts).count();
  double leadMs = framePtsMs - positionMs;

  // Feed the holding loop. This is the same number the overlay reports as
  // buffer depth; the loop keeps it where it was rather than letting it walk.
  if (s_leadSamples == 0) {
    s_leadFilteredMs = leadMs;
  } else {
    s_leadFilteredMs += (leadMs - s_leadFilteredMs) * kLeadFilterAlpha;
  }
  if (s_leadSamples < kLeadSettleSamples) {
    s_leadSamples++;
    if (s_leadSamples == kLeadSettleSamples && !s_leadTargetSet &&
        s_leadFilteredMs >= kLeadTargetMinMs && s_leadFilteredMs <= kLeadTargetMaxMs) {
      s_leadTargetMs = s_leadFilteredMs;
      s_leadTargetSet = true;
      MoonlightInstance::ClLogMessage(
        "Holding the video timeline at %.1f ms of pipeline lead\n", s_leadTargetMs);
    }
  }

  if (collectStats) {
    stats.pipelineClockSamples++;
    stats.pipelineClockLeadSumMs += leadMs;
    stats.pipelineClockLeadSumSqMs += leadMs * leadMs;
    mltelemetry::Add(stats.pipelineLeadUs,
                     ToMicroseconds(std::max(0.0, leadMs)));

    float absLeadMs = (float)std::abs(leadMs);
    if (absLeadMs > stats.pipelineClockLeadMaxMs) {
      stats.pipelineClockLeadMaxMs = absLeadMs;
    }
  }
}

// ─── Presentation stall detection and recovery ───────────────────────────────

static std::atomic<bool> s_recoveryThreadRunning{false};
static std::atomic<bool> s_recoveryRequested{false};
static std::thread s_recoveryThread;
static std::mutex s_recoveryMutex;
static std::condition_variable s_recoveryCv;

// Detector state, touched only by the decoder thread.
static int64_t s_lastSeenPositionUs = MoonlightInstance::kNoPipelinePosition;
static uint32_t s_lastPositionChangeMs = 0;
static uint32_t s_appendsSinceProgress = 0;
static bool s_positionEverAdvanced = false;
static uint32_t s_lastRecoveryMs = 0;
// Largest interval between two position changes seen while the position was
// advancing. This is the platform telling us how often it intends to report.
static uint32_t s_maxHealthyGapMs = 0;

// Recovers a frozen pipeline, off the submission path.
//
// Flushing and re-priming are done here rather than inline because they act on
// the source while the decoder thread is the one that feeds it: doing both from
// the same thread invites the flush to wait on work that only that thread could
// perform. Requesting the keyframe last means the fresh picture arrives into an
// already emptied pipeline.
static void RecoveryLoop() {
  while (s_recoveryThreadRunning.load(std::memory_order_relaxed)) {
    {
      std::unique_lock<std::mutex> lock(s_recoveryMutex);
      s_recoveryCv.wait_for(lock, std::chrono::milliseconds(250), [] {
        return s_recoveryRequested.load(std::memory_order_relaxed) ||
               !s_recoveryThreadRunning.load(std::memory_order_relaxed);
      });
    }
    if (!s_recoveryThreadRunning.load(std::memory_order_relaxed)) {
      break;
    }
    if (!s_recoveryRequested.exchange(false, std::memory_order_acq_rel)) {
      continue;
    }

    MoonlightInstance::PerformPresentationRecovery();
  }
}

// Flushes the pipeline and asks for a fresh keyframe. Runs on the recovery
// worker, never on the submission path.
void MoonlightInstance::PerformPresentationRecovery() {
  if (!g_Instance || !g_Instance->m_Source || !g_Instance->m_VideoStarted.load()) {
    return;
  }

  ClLogMessage("Presentation stalled while packets were still being accepted; "
               "flushing the pipeline and requesting a keyframe\n");

  // A failed flush is not fatal. The keyframe request below is still worth
  // making, and is on its own sometimes enough to restart presentation.
  if (!g_Instance->m_Source->Flush()) {
    ClLogMessage("Pipeline flush was refused\n");
  }

  // The flush threw away what was queued but not where the timeline stands.
  // Without this the offset that caused the stall survives it untouched, and
  // every recovery leaves the stream worse than it found it - which is what
  // turns one visible jump into a stream that degrades until it is restarted.
  s_ptsReanchorRequested.store(true, std::memory_order_release);

  LiRequestIdrFrame();
}

// Called after every accepted append. The position and clock sample are shared
// with RecordPipelineLead(), so the hot path reads each only once per frame.
void MoonlightInstance::NotePresentationProgress(
  bool collectStats, int64_t positionUs, uint32_t nowMs
) {
  if (positionUs == kNoPipelinePosition) {
    // The platform does not report position on this model, so a stall is not
    // observable and the detector stays disarmed for the whole session.
    return;
  }

  if (positionUs != s_lastSeenPositionUs) {
    if (s_lastSeenPositionUs != kNoPipelinePosition && positionUs > s_lastSeenPositionUs) {
      // This gap was healthy by definition: it ended in the position advancing.
      const uint32_t gapMs = nowMs - s_lastPositionChangeMs;
      if (s_positionEverAdvanced && gapMs > s_maxHealthyGapMs) {
        s_maxHealthyGapMs = gapMs;
      }
      s_positionEverAdvanced = true;
    }
    s_lastSeenPositionUs = positionUs;
    s_lastPositionChangeMs = nowMs;
    s_appendsSinceProgress = 0;
    return;
  }

  s_appendsSinceProgress++;

  if (!s_positionEverAdvanced) {
    // Still warming up: the position has never moved, so there is no baseline
    // that says it should be moving now.
    return;
  }
  if (s_appendsSinceProgress < kStallMinAppendsWithoutProgress) {
    return;
  }

  // Until a healthy gap has been measured, there is nothing to compare against
  // and the floor alone would be a guess about the platform's reporting rate.
  if (s_maxHealthyGapMs == 0) {
    return;
  }

  uint32_t thresholdMs = s_maxHealthyGapMs * kStallHealthyGapMultiple;
  if (thresholdMs < kStallFloorMs) {
    thresholdMs = kStallFloorMs;
  }
  if (nowMs - s_lastPositionChangeMs < thresholdMs) {
    return;
  }
  if (nowMs - s_lastRecoveryMs < kStallRecoveryCooldownMs) {
    return;
  }

  s_lastRecoveryMs = nowMs;
  s_appendsSinceProgress = 0;
  if (collectStats) {
    m_ActiveWndVideoStats.presentationRecoveries++;
  }

  s_recoveryRequested.store(true, std::memory_order_release);
  s_recoveryCv.notify_one();
}

static void StartRecoveryThread() {
  if (s_recoveryThread.joinable()) {
    return;
  }
  s_lastSeenPositionUs = MoonlightInstance::kNoPipelinePosition;
  s_lastPositionChangeMs = LiGetMillis();
  s_appendsSinceProgress = 0;
  s_positionEverAdvanced = false;
  s_lastRecoveryMs = 0;
  s_maxHealthyGapMs = 0;
  s_recoveryRequested.store(false, std::memory_order_relaxed);
  s_recoveryThreadRunning.store(true, std::memory_order_release);
  s_recoveryThread = std::thread(RecoveryLoop);
}

static void StopRecoveryThread() {
  if (!s_recoveryThread.joinable()) {
    return;
  }
  s_recoveryThreadRunning.store(false, std::memory_order_release);
  s_recoveryCv.notify_all();
  s_recoveryThread.join();
}

void MoonlightInstance::VidDecCleanup(void) {
  StopRecoveryThread();

  // Clear the decode buffer
  s_DecodeBuffer.clear();

  // Shrink the decode buffer to fit its contents
  s_DecodeBuffer.shrink_to_fit();
}

template<bool CollectStats>
int MoonlightInstance::VidDecSubmitDecodeUnitImpl(PDECODE_UNIT decodeUnit) {
  if constexpr (CollectStats) {
    const uint32_t statsNowMs = LiGetMillis();

    if (!s_collectingStats) {
      memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));
      memset(&m_LastWndVideoStats, 0, sizeof(m_LastWndVideoStats));
      m_ActiveWndVideoStats.measurementStartTimestamp = statsNowMs;
      m_LastFrameNumber = decodeUnit->frameNumber;
      total_bytes = 0;
      s_hasLastAppendTime = false;
      mltelemetry::Reset(s_HitchTracker,
                         SteadyUs(std::chrono::steady_clock::now()));
      s_collectingStats = true;
    } else if (decodeUnit->frameNumber > m_LastFrameNumber) {
      // Frame numbers can restart after an IDR or recovery. Count only forward
      // gaps; unsigned subtraction across a restart would manufacture billions
      // of dropped frames in the overlay.
      if (decodeUnit->frameNumber > m_LastFrameNumber + 1) {
        const uint32_t dropped =
          decodeUnit->frameNumber - (m_LastFrameNumber + 1);
        m_ActiveWndVideoStats.networkDroppedFrames += dropped;
        m_ActiveWndVideoStats.totalFrames += dropped;
      }
      m_LastFrameNumber = decodeUnit->frameNumber;
    } else {
      m_LastFrameNumber = decodeUnit->frameNumber;
    }

    // Flip performance stats window every two seconds. None of this runs
    // while the overlay is hidden.
    if (m_ActiveWndVideoStats.measurementStartTimestamp + kStatsUpdateMs < statsNowMs) {
      // Create a container to hold aggregated stats for display
      VIDEO_STATS lastTwoWndStats = {};
      // Bitrate uses the current window rather than assuming it is exactly one
      // second long.
      const uint32_t windowMs =
        statsNowMs - m_ActiveWndVideoStats.measurementStartTimestamp;
      lastTwoWndStats.receivedBitrate = windowMs != 0
        ? static_cast<float>((total_bytes * 8.0) / 1000.0 / windowMs)
        : 0.0f;
      // Add last window and current window to the aggregated stats
      AddVideoStats(m_LastWndVideoStats, lastTwoWndStats);
      AddVideoStats(m_ActiveWndVideoStats, lastTwoWndStats);
      // Convert the aggregated stats to a display string
      if (g_Instance->m_OverlayStatsEnabled.load(std::memory_order_relaxed)) {
        FormatVideoStats(lastTwoWndStats, s_StatString.data(), s_StatString.length());
      // Send the formatted stats string to the JS frontend for overlay display.
      // This must not be the synchronous variant: it would block the decoder
      // thread until the main thread has finished the DOM update, which is
      // exactly the wrong thing to do on the frame submission path.
      s_PendingStatMsg.assign("StatMsg: ");
      s_PendingStatMsg.append(s_StatString.data());
      PostToJsAsync(s_PendingStatMsg);
      // Clear the stats string buffer for the next use
      std::fill(s_StatString.begin(), s_StatString.end(), 0);
      }
      const uint32_t generation =
        g_Instance->m_DiagnosticsGeneration.load(std::memory_order_relaxed);
      if (generation != 0) {
        // Non-overlapping windows for session totals; never sum the overlay's
        // overlapping windows or mistake a sampled p95 for a session p95.
        PublishDiagnostics(m_ActiveWndVideoStats, windowMs, statsNowMs, generation);
      }
      total_bytes = 0;
      memcpy(&m_LastWndVideoStats, &m_ActiveWndVideoStats,
             sizeof(m_ActiveWndVideoStats));
      memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));
      m_ActiveWndVideoStats.measurementStartTimestamp = statsNowMs;
    }

    total_bytes += decodeUnit->fullLength;
    mltelemetry::Add(m_ActiveWndVideoStats.frameBytes,
                     static_cast<uint32_t>(decodeUnit->fullLength));

    if (decodeUnit->frameHostProcessingLatency != 0) {
      if (m_ActiveWndVideoStats.minHostProcessingLatency != 0) {
        m_ActiveWndVideoStats.minHostProcessingLatency = MIN(
          m_ActiveWndVideoStats.minHostProcessingLatency,
          decodeUnit->frameHostProcessingLatency);
      } else {
        m_ActiveWndVideoStats.minHostProcessingLatency =
          decodeUnit->frameHostProcessingLatency;
      }
      m_ActiveWndVideoStats.framesWithHostProcessingLatency++;
    }

    m_ActiveWndVideoStats.maxHostProcessingLatency = MAX(
      m_ActiveWndVideoStats.maxHostProcessingLatency,
      decodeUnit->frameHostProcessingLatency);
    m_ActiveWndVideoStats.totalHostProcessingLatency +=
      decodeUnit->frameHostProcessingLatency;
    m_ActiveWndVideoStats.receivedFrames++;
    m_ActiveWndVideoStats.totalFrames++;
  } else if (s_collectingStats) {
    // One transition write, then no overlay state is touched again until it is
    // explicitly enabled.
    s_collectingStats = false;
    total_bytes = 0;
  }

  // Derive this frame's timestamp from the host presentation clock and commit
  // it immediately. The timeline has to advance with the host regardless of
  // what happens to this frame below: holding it back on a drop or on a failed
  // append is what makes the video track shrink against real time and against
  // the audio track.
  TimeStamp framePts = NextPacketPts(decodeUnit, s_pktPts);
  s_pktPts = framePts;

  // There is deliberately no queue-depth frame shedding here.
  //
  // A previous version dropped P-frames once the decode unit queue passed a
  // threshold, reasoning that losing one frame beats the wholesale flush that
  // moonlight-common-c performs when the queue hits its bound. That reasoning
  // was wrong, and the difference matters.
  //
  // The stream carries no periodic keyframes: the host emits an IDR only when
  // asked. Every P-frame is coded against the one before it, so a P-frame
  // discarded here leaves the decoder referencing a picture it never received,
  // and the error propagates through every frame that follows until something
  // requests an IDR. Returning DR_OK told moonlight-common-c the frame had been
  // handled, so nothing ever did. The result was not one lost frame, it was
  // corruption lasting until the next keyframe happened to be requested for an
  // unrelated reason.
  //
  // The library's own overflow path is the correct behaviour and was already
  // there: it flushes the queue and requests an IDR, which costs one visible
  // recovery and then resynchronises cleanly. Letting it handle the rare
  // overload is strictly better than silently corrupting the reference chain.
  // Anything below that genuinely cannot proceed must return DR_NEED_IDR.

  std::chrono::time_point<std::chrono::steady_clock> assemblyStart;
  if constexpr (CollectStats) {
    assemblyStart = std::chrono::steady_clock::now();
  }

  // Assemble the packet.
  //
  // A decode unit that arrived as a single contiguous entry needs no assembly at
  // all: the buffer belongs to the decoder thread until AppendPacket returns, so
  // the platform can read it where it lies. Multi-packet frames arrive as a list
  // of entries and must be made contiguous for the Samsung packet API. IDRs may
  // additionally need the H.264 SPS rewritten in transit.
  PLENTRY entry = decodeUnit->bufferList;
  unsigned int offset;
  const unsigned char* packetData;

  const bool needsSpsFixup = (decodeUnit->frameType == FRAME_TYPE_IDR) &&
                             (s_VideoFormat & VIDEO_FORMAT_H264);

  if (!needsSpsFixup && entry != NULL && entry->next == NULL &&
      entry->length == decodeUnit->fullLength) {
    packetData = reinterpret_cast<const unsigned char*>(entry->data);
    offset = (unsigned int)decodeUnit->fullLength;
    if constexpr (CollectStats) {
      m_ActiveWndVideoStats.zeroCopyFrames++;
    }
  } else {
    unsigned int totalLength = decodeUnit->fullLength;

    // Check if the frame type from the decoding unit is IDR frame
    if (decodeUnit->frameType == FRAME_TYPE_IDR) {
      // Add some extra space in case we need to do an SPS fixup
      totalLength += MAX_SPS_EXTRA_SIZE;
    }

    // Ensure the decode buffer is large enough to hold the full packet
    if (totalLength > s_DecodeBuffer.size()) {
      // Resize decode buffer to accommodate the larger data
      s_DecodeBuffer.resize(totalLength);
    }

    // Initialize the offset to 0 before starting to copy data
    offset = 0;

    // Iterate through the buffer list of video data entries
    while (entry != NULL) {
      bool copied = false;

      // The SPS of an H.264 IDR frame is rewritten on the way through, so the
      // decoder is told the stream is low delay. See FixupSps(). Everything
      // else, including every HEVC parameter set, is copied verbatim.
      if (entry->bufferType == BUFFER_TYPE_SPS && (s_VideoFormat & VIDEO_FORMAT_H264)) {
        unsigned int room = (unsigned int)(s_DecodeBuffer.size() - offset);
        unsigned int fixedLen = FixupSps(
          reinterpret_cast<const uint8_t*>(entry->data), (unsigned int)entry->length,
          &s_DecodeBuffer[offset], room
        );
        if (fixedLen > 0) {
          offset += fixedLen;
          copied = true;
          if (!s_loggedSpsFixup) {
            s_loggedSpsFixup = true;
            ClLogMessage("H.264 SPS rewritten for low delay decoding (stage %d)\n",
                         kSpsFixupStage);
          }
        }
      }

      if (!copied) {
        // Copy the data of the current entry to the decode buffer at the specified offset
        memcpy(&s_DecodeBuffer[offset], entry->data, entry->length);
        // Update the offset based on the length of the copied data
        offset += entry->length;
      }

      // Move to the next entry in the buffer list
      entry = entry->next;
    }

    packetData = s_DecodeBuffer.data();
  }

  if constexpr (CollectStats) {
    const auto assemblyEnd = std::chrono::steady_clock::now();
    const auto assemblyUs = static_cast<uint32_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(
        assemblyEnd - assemblyStart).count());
    mltelemetry::Add(m_ActiveWndVideoStats.assemblyUs, assemblyUs);

    // Count fragments in a diagnostic-only pass. The normal path retains the
    // exact v3.3.6 loop and pays no extra branch per packet while stats are off.
    uint32_t packetCount = 0;
    for (PLENTRY packetEntry = decodeUnit->bufferList;
         packetEntry != NULL; packetEntry = packetEntry->next) {
      packetCount++;
    }
    mltelemetry::Add(m_ActiveWndVideoStats.framePackets, packetCount);
  }

  const auto packetSessionId = g_Instance->m_VideoSessionId.load();

  // Create an ElementaryMediaPacket and start decoding with the decoded video data
  samsung::wasm::ElementaryMediaPacket pkt {
    framePts, // presentation timestamp
    framePts, // decoding timestamp
    s_frameDuration, // packet duration
    decodeUnit->frameType == FRAME_TYPE_IDR, // packet of frame type
    offset, // packet size
    packetData, // pointer to packet payload
    s_Width, // packet of width
    s_Height, // packet of height
    s_Framerate, // packet of framerate numerator
    1, // packet of framerate denominator
    packetSessionId // session identifier
  };

  // Timing measurements are overlay-only. Avoid three extra clock reads per
  // frame when the overlay is hidden.
  if constexpr (CollectStats) {
    m_ActiveWndVideoStats.totalReassemblyTime +=
      decodeUnit->enqueueTimeMs - decodeUnit->receiveTimeMs;
    m_ActiveWndVideoStats.totalDecodeTime +=
      LiGetMillis() - decodeUnit->enqueueTimeMs;
  }
  if constexpr (CollectStats) {
    m_ActiveWndVideoStats.decodedFrames++;
  }

  std::chrono::time_point<std::chrono::steady_clock> appendStart;
  if constexpr (CollectStats) {
    appendStart = std::chrono::steady_clock::now();
  }

  // Hand the packet over.
  //
  // There is no retry loop. This now runs on the thread that drains the socket,
  // and holding it for a further attempt would trade a lost frame for lost
  // packets, which is the worse of the two.
  const bool appended = (bool)g_Instance->m_VideoTrack.AppendPacket(pkt);

  if (appended) {
    const uint32_t appendNowMs = LiGetMillis();
    if constexpr (CollectStats) {
      const auto appendEnd = std::chrono::steady_clock::now();
      const auto appendUs = static_cast<uint32_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
          appendEnd - appendStart).count());
      mltelemetry::Add(m_ActiveWndVideoStats.appendUs, appendUs);
      m_ActiveWndVideoStats.totalRenderTime += appendUs / 1000;
      m_ActiveWndVideoStats.renderedFrames++;
      RecordAppendCadence(m_ActiveWndVideoStats);
    }

    const int64_t positionUs =
      g_Instance->m_PipelinePositionUs.load(std::memory_order_acquire);
    const uint64_t reportedAtMs =
      g_Instance->m_PipelinePositionAtMs.load(std::memory_order_relaxed);
    RecordPipelineLead(m_ActiveWndVideoStats, framePts, CollectStats,
                       positionUs, reportedAtMs, appendNowMs);
    NotePresentationProgress(CollectStats, positionUs, appendNowMs);
  } else {
    // Throttle IDR requests. A keyframe costs several times a P-frame, so
    // asking for one on every rejected packet congests the link further and
    // provokes another round of rejections.
    uint32_t nowMs = LiGetMillis();
    if (nowMs - s_lastIdrRequestMs >= kIdrRequestIntervalMs) {
      s_lastIdrRequestMs = nowMs;
      ClLogMessage("Append video packet failed, requesting IDR\n");
      return DR_NEED_IDR;
    }
    // A refresh is already on its way, so drop this frame quietly
    if constexpr (CollectStats) {
      m_ActiveWndVideoStats.pacerDroppedFrames++;
    }
  }

  return DR_OK;
}

int MoonlightInstance::VidDecSubmitDecodeUnit(PDECODE_UNIT decodeUnit) {
  if (!g_Instance->m_VideoStarted) {
    return DR_OK;
  }
  if (g_Instance->m_PerformanceStatsEnabled.load(std::memory_order_relaxed)) {
    return VidDecSubmitDecodeUnitImpl<true>(decodeUnit);
  }
  return VidDecSubmitDecodeUnitImpl<false>(decodeUnit);
}

void MoonlightInstance::AddVideoStats(VIDEO_STATS& src, VIDEO_STATS& dst) {
  // Accumulate video stats from src into dst for aggregated metrics
  dst.receivedFrames += src.receivedFrames;
  dst.decodedFrames += src.decodedFrames;
  dst.renderedFrames += src.renderedFrames;
  dst.totalFrames += src.totalFrames;
  dst.networkDroppedFrames += src.networkDroppedFrames;
  dst.pacerDroppedFrames += src.pacerDroppedFrames;
  dst.totalReassemblyTime += src.totalReassemblyTime;
  dst.totalDecodeTime += src.totalDecodeTime;
  dst.totalRenderTime += src.totalRenderTime;

  // Cadence instrumentation. Sums merge by addition; the max does not.
  dst.appendIntervalCount += src.appendIntervalCount;
  dst.appendIntervalSumMs += src.appendIntervalSumMs;
  dst.appendIntervalSumSqMs += src.appendIntervalSumSqMs;
  dst.appendJitterOutliers += src.appendJitterOutliers;
  dst.hostIntervalCount += src.hostIntervalCount;
  dst.hostIntervalSumMs += src.hostIntervalSumMs;
  dst.hostIntervalSumSqMs += src.hostIntervalSumSqMs;
  dst.pipelineClockSamples += src.pipelineClockSamples;
  dst.pipelineClockLeadSumMs += src.pipelineClockLeadSumMs;
  dst.pipelineClockLeadSumSqMs += src.pipelineClockLeadSumSqMs;
  dst.pipelineClockLeadMaxMs = MAX(dst.pipelineClockLeadMaxMs, src.pipelineClockLeadMaxMs);
  dst.zeroCopyFrames += src.zeroCopyFrames;
  dst.presentationRecoveries += src.presentationRecoveries;
  mltelemetry::Merge(src.appendIntervalsUs, dst.appendIntervalsUs);
  mltelemetry::Merge(src.hostIntervalsUs, dst.hostIntervalsUs);
  mltelemetry::Merge(src.frameBytes, dst.frameBytes);
  mltelemetry::Merge(src.framePackets, dst.framePackets);
  mltelemetry::Merge(src.assemblyUs, dst.assemblyUs);
  mltelemetry::Merge(src.appendUs, dst.appendUs);
  mltelemetry::Merge(src.pipelineLeadUs, dst.pipelineLeadUs);
  dst.appendLateIntervals += src.appendLateIntervals;
  dst.appendEarlyIntervals += src.appendEarlyIntervals;
  dst.hostLateIntervals += src.hostLateIntervals;

  // Update minimum host processing latency if it's not set or if the source has a valid smaller value
  if (dst.minHostProcessingLatency == 0) {
    dst.minHostProcessingLatency = src.minHostProcessingLatency;
  } else if (src.minHostProcessingLatency != 0) {
    dst.minHostProcessingLatency = MIN(dst.minHostProcessingLatency, src.minHostProcessingLatency);
  }

  // Update the maximum host processing latency if the current source value is higher
  dst.maxHostProcessingLatency = MAX(dst.maxHostProcessingLatency, src.maxHostProcessingLatency);
  dst.totalHostProcessingLatency += src.totalHostProcessingLatency;
  dst.framesWithHostProcessingLatency += src.framesWithHostProcessingLatency;

  // Attempt to retrieve the latest estimated RTT and variance
  if (!LiGetEstimatedRttInfo(&dst.lastRtt, &dst.lastRttVariance)) {
    // Set RTTs to 0 if unavailable
    dst.lastRtt = 0;
    dst.lastRttVariance = 0;
  } else {
    // Our logic to determine if RTT is valid depends on us never
    // getting an RTT of 0. ENet currently ensures RTTs are >= 1.
    assert(dst.lastRtt > 0);
  }

  // Get the current time in milliseconds
  auto now = LiGetMillis();

  // Initialize the measurement start point if this is the first video stat window
  if (!dst.measurementStartTimestamp) {
    dst.measurementStartTimestamp = src.measurementStartTimestamp;
  }

  // Ensure the global measurement timestamp has already started first
  assert(dst.measurementStartTimestamp <= src.measurementStartTimestamp);

  // Compute frames per second metrics for various stages of the video pipeline
  dst.totalFps = (float)dst.totalFrames / ((float)(now - dst.measurementStartTimestamp) / 1000);
  dst.receivedFps = (float)dst.receivedFrames / ((float)(now - dst.measurementStartTimestamp) / 1000);
  dst.decodedFps = (float)dst.decodedFrames / ((float)(now - dst.measurementStartTimestamp) / 1000);
  dst.renderedFps = (float)dst.renderedFrames / ((float)(now - dst.measurementStartTimestamp) / 1000);
}

void MoonlightInstance::FormatVideoStats(VIDEO_STATS& stats, char* output, int length) {
  const char* codecString;
  switch (s_VideoFormat) {
    case VIDEO_FORMAT_H264:
      codecString = "H264";
      break;
    case VIDEO_FORMAT_H265:
      codecString = "HEVC";
      break;
    case VIDEO_FORMAT_H265_MAIN10:
      codecString = LiGetCurrentHostDisplayHdrMode() ? "HEVC10 HDR" : "HEVC10 SDR";
      break;
    case VIDEO_FORMAT_AV1_MAIN8:
      codecString = "AV1";
      break;
    case VIDEO_FORMAT_AV1_MAIN10:
      codecString = LiGetCurrentHostDisplayHdrMode() ? "AV1-10 HDR" : "AV1-10 SDR";
      break;
    default:
      assert(false);
      codecString = "?";
      break;
  }

  const auto host = mltelemetry::Summarize(stats.hostIntervalsUs, 1000.0);
  const auto loadBytes = mltelemetry::Summarize(stats.frameBytes, 1024.0);
  const auto loadPackets = mltelemetry::Summarize(stats.framePackets);
  const auto assembly = mltelemetry::Summarize(stats.assemblyUs, 1000.0);
  const auto append = mltelemetry::Summarize(stats.appendUs, 1000.0);
  const auto cadence = mltelemetry::Summarize(stats.appendIntervalsUs, 1000.0);
  const auto pipeline = mltelemetry::Summarize(stats.pipelineLeadUs, 1000.0);
  const auto hitchPeriod = mltelemetry::Summarize(s_HitchTracker.periodsUs, 1000000.0);

  const double hostFps = host.mean > 0.0 ? 1000.0 / host.mean : 0.0;
  const double networkLoss = stats.totalFrames != 0
    ? stats.networkDroppedFrames * 100.0 / stats.totalFrames : 0.0;
  const double hostLate = stats.hostIntervalCount != 0
    ? stats.hostLateIntervals * 100.0 / stats.hostIntervalCount : 0.0;
  const double appendLate = stats.appendIntervalCount != 0
    ? stats.appendLateIntervals * 100.0 / stats.appendIntervalCount : 0.0;
  const double encodeAverage = stats.framesWithHostProcessingLatency != 0
    ? static_cast<double>(stats.totalHostProcessingLatency) /
      stats.framesWithHostProcessingLatency / 10.0 : 0.0;
  const double zeroCopy = stats.decodedFrames != 0
    ? stats.zeroCopyFrames * 100.0 / stats.decodedFrames : 0.0;
  const uint64_t nowUs = SteadyUs(std::chrono::steady_clock::now());
  const double hitchesPerMinute =
    mltelemetry::EventsPerMinute(s_HitchTracker, nowUs);

  char pipelineText[80];
  if (stats.pipelineClockSamples > 1) {
    snprintf(pipelineText, sizeof(pipelineText),
             "Pipe a/p/x: %.1f/%.1f/%.1fms r%u",
             pipeline.mean, pipeline.p95, pipeline.maximum,
             stats.presentationRecoveries);
  } else {
    snprintf(pipelineText, sizeof(pipelineText),
             "Pipe: -- r%u", stats.presentationRecoveries);
  }

  const int ret = snprintf(
    output, length,
    "Str: %ux%u %s %ufps %.1fMb\n"
    "FPS H/R/S/O: %.2f/%.2f/%.2f/@PFPS@\n"
    "Net: loss %.2f%% RTT %u+/-%ums apprej %u\n"
    "Host: i%.2f p%.2f d%.2fms l%.1f%% enc %.1f/%.1fms\n"
    "Load a/p/x: %.0f/%.0f/%.0fKB %.0f/%.0f/%.0fpkts\n"
    "Work a/p/x: asm %.2f/%.2f/%.2f app %.2f/%.2f/%.2fms zc%.0f%%\n"
    "Cad: d%.2f p%.2f x%.2fms l%.1f%% H%.1f/m T%.1f/%.1fs b%u\n"
    "%s | @DISP@\n",
    s_Width, s_Height, codecString, s_Framerate, stats.receivedBitrate,
    hostFps, stats.receivedFps, stats.renderedFps,
    networkLoss, stats.lastRtt, stats.lastRttVariance,
    stats.pacerDroppedFrames,
    host.mean, host.p95, host.deviation, hostLate, encodeAverage,
    stats.maxHostProcessingLatency / 10.0,
    loadBytes.mean, loadBytes.p95, loadBytes.maximum,
    loadPackets.mean, loadPackets.p95, loadPackets.maximum,
    assembly.mean, assembly.p95, assembly.maximum,
    append.mean, append.p95, append.maximum, zeroCopy,
    cadence.deviation, cadence.p95, cadence.maximum, appendLate,
    hitchesPerMinute, hitchPeriod.mean, hitchPeriod.p95,
    s_HitchTracker.maxBurst, pipelineText);

  if (ret < 0 || ret >= length) {
    assert(false);
    if (length > 0) {
      output[0] = 0;
    }
  }
}

void MoonlightInstance::PublishDiagnostics(VIDEO_STATS& stats, uint32_t windowMs,
                                          uint32_t nowMs, uint32_t generation) {
  // This function is reached only inside the instrumented specialization and
  // only for an explicitly armed session. It never changes playback state.
  const auto host = mltelemetry::Summarize(stats.hostIntervalsUs, 1000.0);
  const auto assembly = mltelemetry::Summarize(stats.assemblyUs, 1000.0);
  const auto append = mltelemetry::Summarize(stats.appendUs, 1000.0);
  const auto cadence = mltelemetry::Summarize(stats.appendIntervalsUs, 1000.0);
  uint32_t rtt = 0, variance = 0;
  const bool rttValid = LiGetEstimatedRttInfo(&rtt, &variance);
  const auto position = g_Instance->m_PipelinePositionUs.load(std::memory_order_acquire);
  const auto at = g_Instance->m_PipelinePositionAtMs.load(std::memory_order_relaxed);
  const double age = position == kNoPipelinePosition ? -1.0 :
    (nowMs >= at ? static_cast<double>(nowMs - at) : -1.0);
  const double lead = stats.pipelineClockSamples
    ? stats.pipelineClockLeadSumMs / stats.pipelineClockSamples : 0.0;
  const double encode = stats.framesWithHostProcessingLatency
    ? stats.totalHostProcessingLatency / 10.0 / stats.framesWithHostProcessingLatency : -1.0;
  char message[2048];
  const int length = snprintf(message, sizeof(message),
    "DiagMsg: {\"gen\":%u,\"ms\":%u,\"w\":%u,\"h\":%u,\"fmt\":%u,\"fps\":%u,"
    "\"bytes\":%.0f,\"rx\":%u,\"sub\":%u,\"total\":%u,\"lost\":%u,\"rej\":%u,\"rec\":%u,"
    "\"rtt\":%.0f,\"rttVar\":%u,\"hostN\":%u,\"hostLate\":%u,\"hostMean\":%.3f,"
    "\"hostP95\":%.3f,\"enc\":%.3f,\"encMax\":%.3f,"
    "\"asm\":%.3f,\"asmP95\":%.3f,\"asmMax\":%.3f,"
    "\"app\":%.3f,\"appP95\":%.3f,\"appMax\":%.3f,"
    "\"cadN\":%u,\"cadLate\":%u,\"cadP95\":%.3f,\"cadMax\":%.3f,"
    "\"leadN\":%u,\"lead\":%.3f,\"leadAbsMax\":%.3f,"
    "\"filtered\":%.3f,\"target\":%.3f,\"servo\":%u,\"settle\":%u,"
    "\"clockAge\":%.3f,\"step\":%.5f}",
    generation, windowMs, s_Width, s_Height, s_VideoFormat, s_Framerate,
    static_cast<double>(total_bytes), stats.receivedFrames, stats.renderedFrames,
    stats.totalFrames, stats.networkDroppedFrames, stats.pacerDroppedFrames,
    stats.presentationRecoveries, rttValid ? static_cast<double>(rtt) : -1.0, variance,
    stats.hostIntervalCount, stats.hostLateIntervals, host.mean, host.p95,
    encode, stats.maxHostProcessingLatency / 10.0,
    assembly.mean, assembly.p95, assembly.maximum,
    append.mean, append.p95, append.maximum,
    stats.appendIntervalCount, stats.appendLateIntervals, cadence.p95, cadence.maximum,
    stats.pipelineClockSamples, lead, static_cast<double>(stats.pipelineClockLeadMaxMs),
    s_leadFilteredMs, s_leadTargetMs, s_leadTargetSet ? 1u : 0u,
    static_cast<unsigned>(s_leadSamples), age,
    std::chrono::duration<double, std::milli>(s_ptsStep).count());
  if (length > 0 && length < sizeof(message)) PostToJsAsync(message);
}

void MoonlightInstance::TogglePerformanceStats() {
  const bool visible = !m_OverlayStatsEnabled.load();
  m_OverlayStatsEnabled = visible;
  m_PerformanceStatsEnabled = visible || m_DiagnosticsGeneration.load() != 0;
  // State changes are distinct from queued samples: an old sample cannot turn
  // collection or the presentation observer back on after the user disabled it.
  PostToJs(visible ? "OverlayState: 1" : "OverlayState: 0");
}

void MoonlightInstance::SetDiagnostics(uint32_t generation) {
  m_DiagnosticsGeneration = generation;
  m_PerformanceStatsEnabled = generation != 0 || m_OverlayStatsEnabled.load();
}

void MoonlightInstance::WaitFor(std::condition_variable* variable, std::function<bool()> condition) {
  std::unique_lock<std::mutex> lock(m_Mutex);
  variable->wait(lock, [&]() { return m_ConnectionCancelled.load() || condition(); });
}

DECODER_RENDERER_CALLBACKS MoonlightInstance::s_DrCallbacks = {
  .setup = MoonlightInstance::VidDecSetup,
  .cleanup = MoonlightInstance::VidDecCleanup,
  .submitDecodeUnit = MoonlightInstance::VidDecSubmitDecodeUnit,
  // DIRECT_SUBMIT hands each frame over on the thread that received its last
  // packet, instead of queueing it for a decoder thread to pick up.
  //
  // That queue was costing more than it was worth. Measured on hardware with a
  // still picture, where frames are two packets long and network latency varies
  // by a millisecond, the interval between frames reaching the platform still
  // varied by nearly ten. A handoff whose far end has to be woken by the
  // scheduler cannot be tighter than the scheduler is, and on a TV running a
  // dozen threads across few cores that is not tight. Submitting where the frame
  // is completed removes the wake-up entirely.
  //
  // This is only safe because nothing on the submission path waits: the pacer
  // that used to hold frames is gone, and the append is attempted once.
  //
  // One slice per frame. Slicing exists to let a multithreaded software decoder
  // work on a frame in parallel; this pipeline hands the bitstream to the TV's
  // hardware decoder, where extra slices only add bitstream overhead and cost
  // compression efficiency at the same bitrate.
  .capabilities = CAPABILITY_DIRECT_SUBMIT | CAPABILITY_SLICES_PER_FRAME(1),
};
