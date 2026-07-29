#include "moonlight_wasm.hpp"

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>

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

static constexpr TimeStamp kFrameTimeMargin = 0.5ms;
static constexpr TimeStamp kTimeWindow = 1s;

// Pacing sleeps until this close to the deadline, then finishes with a short
// bounded wait. Sleeping the whole way overshoots on a coarse scheduler;
// spinning the whole way pegs a core, which is what the previous
// implementation did.
static constexpr TimeStamp kPacingSleepFloor = 1ms;

// Hard ceiling on how long a single frame may be held back by the pacer,
// expressed as a multiple of the frame duration. Without it, a bad pacing
// reference could stall the decoder thread indefinitely.
static constexpr int kPacingMaxWaitFrames = 2;

// Per-second correction applied to the pacing reference. It is a small
// proportional step rather than an instant jump: assigning the whole measured
// drift at once releases every frame being held in a single burst, which is
// visible as a hitch roughly once per second.
static constexpr double kPacingDriftGain = 0.1;
static constexpr TimeStamp kPacingMaxDriftStep = 1ms;

// Largest inter-frame gap still trusted from the host presentation clock.
// Anything beyond this is treated as a discontinuity, not as a real gap.
static constexpr int64_t kMaxHostPtsGapMs = 2000;

// Minimum interval between IDR requests triggered by append failures. A
// keyframe costs several times a P-frame, so one request per rejected packet
// turns a congested link into a worse one.
static constexpr uint32_t kIdrRequestIntervalMs = 500;

static uint32_t s_VideoFormat = 0;
static uint32_t s_Width = 0;
static uint32_t s_Height = 0;
static uint32_t s_Framerate = 0;

static std::vector<unsigned char> s_DecodeBuffer;

static TimeStamp s_frameDuration;
static TimeStamp s_pktPts;

static TimeStamp s_ptsDiff;
static TimeStamp s_lastSec;
static bool s_ptsDiffSeeded = false;

// Host presentation clock tracking, see NextPacketPts()
static uint32_t s_lastHostPtsMs = 0;
static bool s_hasHostPtsRef = false;
static bool s_loggedPtsSource = false;

// One-shot log guard for the pipeline clock, so its absence is visible in the
// log by omission rather than its presence being repeated every update.
static bool s_loggedPipelineClock = false;

// Cadence instrumentation. The interval between successive appends is the one
// thing we can measure without the platform's cooperation, and its spread is
// what a frame rate average hides.
static std::chrono::time_point<std::chrono::steady_clock> s_lastAppendTime;
static bool s_hasLastAppendTime = false;

// An interval this far from one frame duration counts as an outlier. A quarter
// of a frame at 60 Hz is about 4 ms, which is roughly where a cadence error
// stops being invisible.
static constexpr double kAppendJitterToleranceMs = 4.0;

static std::chrono::time_point<std::chrono::steady_clock> s_firstAppend;

static bool s_hasFirstFrame = false;
static bool s_FramePacingEnabled = false;

static uint32_t s_lastIdrRequestMs = 0;

// Parks the decoder thread while pacing. Nothing ever notifies it; wait_for()
// is used because it lowers to a futex wait, which genuinely blocks the worker,
// unlike sleep primitives that may degrade to a spin under Emscripten.
static std::mutex s_PacerMutex;
static std::condition_variable s_PacerCv;

// PostToJsAsync() hands a raw pointer to the main thread and returns before the
// main thread reads it, so the payload has to outlive the call. Only the video
// decoder thread writes this, and only once per second.
static std::string s_PendingStatMsg;

static uint32_t total_bytes = 0;
static int m_LastFrameNumber = 0;

static std::string s_StatString = "";

static VIDEO_STATS m_ActiveWndVideoStats;
static VIDEO_STATS m_LastWndVideoStats;
static VIDEO_STATS m_GlobalVideoStats;

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
    const char *mimetype = "video/mp4"; // MIME-type: Video MP4 Container
    if (videoFormat & VIDEO_FORMAT_H264) {
      mimetype = "video/mp4; codecs=\"avc1.64002A\""; // Video codec: H.264 High Level Profile 4.2
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.1 (avc1.640033); */
      ClLogMessage("Video codec profile selected: H.264 High Level Profile 4.2\n");
    } else if (videoFormat & VIDEO_FORMAT_H265) {
      mimetype = "video/mp4; codecs=\"hev1.1.6.L153.B0\""; // Video Codec: HEVC Main Level Profile 5.1
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.2 (hev1.1.6.L156.B0); */
      ClLogMessage("Video codec profile selected: HEVC Main Level Profile 5.1\n");
    } else if (videoFormat & VIDEO_FORMAT_H265_MAIN10) {
      mimetype = "video/mp4; codecs=\"hev1.2.4.L153.B0\""; // Video Codec: HEVC Main10 Level Profile 5.1
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.2 (hev1.2.4.L156.B0); */
      ClLogMessage("Video codec profile selected: HEVC Main10 Level Profile 5.1\n");
    } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN8) {
      mimetype = "video/mp4; codecs=\"av01.0.13M.08\""; // Video Codec: AV1 Main Level Profile 5.1
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.2 (av01.0.14M.08); */
      ClLogMessage("Video codec profile selected: AV1 Main Level Profile 5.1\n");
    } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN10) {
      mimetype = "video/mp4; codecs=\"av01.0.13M.10\""; // Video Codec: AV1 Main10 Level Profile 5.1
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.2 (av01.0.14M.10); */
      ClLogMessage("Video codec profile selected: AV1 Main10 Level Profile 5.1\n");
    } else {
      ClLogMessage("Failed to select video codec profile (videoFormat=0x%x)\n", videoFormat);
      return -1;
    }

    ClLogMessage("Using mimeType %s\n", mimetype);
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

  // Flag indicating whether this is the first frame of video to be decoded
  s_hasFirstFrame = false;

  // Initialize the last second timestamp to zero
  s_lastSec = 0s;

  // Initialize the timestamp difference to zero
  s_ptsDiff = 0s;
  s_ptsDiffSeeded = false;

  // Reset host presentation clock tracking for the new stream
  s_hasHostPtsRef = false;
  s_lastHostPtsMs = 0;
  s_loggedPtsSource = false;

  // Reset the IDR request throttle for the new stream
  s_lastIdrRequestMs = 0;

  // Reset the cadence instrumentation. The first append of a stream has no
  // predecessor to measure against, and the pipeline of the previous stream has
  // nothing to say about this one.
  s_hasLastAppendTime = false;
  s_loggedPipelineClock = false;
  g_Instance->m_PipelinePositionUs.store(kNoPipelinePosition, std::memory_order_release);
  g_Instance->m_PipelinePositionAtMs.store(0, std::memory_order_relaxed);

  // Set the frame pacing flag based on instance configuration
  s_FramePacingEnabled = g_Instance->m_FramePacingEnabled;

  // Preallocate space for the performance stats string. The cadence block added
  // several lines, and FormatVideoStats() asserts rather than truncating.
  s_StatString.resize(2000);

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

  // Reset global video statistics for new decoding session
  memset(&m_GlobalVideoStats, 0, sizeof(m_GlobalVideoStats));

  // Ensure that StartupVidDecSetup is called every time when VidDecSetup is invoked to reinitialize the media pipeline
  int initVidDec = StartupVidDecSetup(videoFormat, width, height, redrawRate, context, drFlags);

  // Check and handle errors from video decoding configuration and propagating failures
  if (initVidDec != 0) {
    ClLogMessage("Initialization of video decoding configuration failed: %d\n", initVidDec);
    return initVidDec;
  }

  return DR_OK;
}

// Derives the presentation timestamp for the frame about to be submitted.
//
// The preferred source is decodeUnit->presentationTimeMs, which
// moonlight-common-c derives from the RTP timestamp, i.e. the host's capture
// clock. Advancing by the host's own inter-frame delta keeps the video timeline
// anchored to real time across losses. The previous scheme added one frame
// duration per *accepted* frame, so every frame lost on the network shortened
// the timeline permanently and pushed video progressively out of sync with
// audio.
//
// The Samsung EMSS headers are not part of this tree, so this is deliberately
// defensive: a host that never fills presentationTimeMs produces a delta of
// zero on every frame and falls back to the old synthetic step automatically.
// The result is strictly monotonic either way.
static TimeStamp NextPacketPts(PDECODE_UNIT decodeUnit, TimeStamp previousPts) {
  uint32_t hostMs = decodeUnit->presentationTimeMs;

  if (!s_hasHostPtsRef) {
    s_hasHostPtsRef = true;
    s_lastHostPtsMs = hostMs;
    // Anchor the timeline at zero like the previous implementation did, so the
    // baseline offset against the audio track is unchanged.
    return TimeStamp(0);
  }

  int64_t deltaMs = static_cast<int64_t>(hostMs) - static_cast<int64_t>(s_lastHostPtsMs);
  s_lastHostPtsMs = hostMs;

  if (deltaMs <= 0 || deltaMs > kMaxHostPtsGapMs) {
    // Unusable for this frame: unpopulated field, reordering, clock wraparound
    // or a discontinuity. Fall back to a single frame step.
    return previousPts + s_frameDuration;
  }

  if (!s_loggedPtsSource) {
    s_loggedPtsSource = true;
    MoonlightInstance::ClLogMessage("Video PTS is following the host presentation clock\n");
  }

  return previousPts + TimeStamp(static_cast<double>(deltaMs) / 1000.0);
}

// Holds the decoder thread until the frame is due.
//
// The previous implementation was a bare spin on steady_clock::now(), which
// under Emscripten is a JS call per iteration and keeps the decoder worker at
// 100% CPU for most of every frame interval. On a TV SoC that starves the audio
// receive thread and the main thread, and the resulting delay backs up the
// 15-entry decode unit queue until it is flushed wholesale.
static void PaceFrame(TimeStamp framePts) {
  auto now = std::chrono::steady_clock::now();
  TimeStamp fromStart = now - s_firstAppend;

  TimeStamp deadline = framePts + s_ptsDiff - kFrameTimeMargin;
  if (fromStart >= deadline) {
    return;
  }

  // Never hold a frame for more than a couple of frame intervals, whatever the
  // pacing reference happens to say.
  TimeStamp maxDeadline = fromStart + s_frameDuration * kPacingMaxWaitFrames;
  if (deadline > maxDeadline) {
    deadline = maxDeadline;
  }

  while (fromStart < deadline) {
    TimeStamp remaining = deadline - fromStart;
    if (remaining > kPacingSleepFloor) {
      std::unique_lock<std::mutex> lock(s_PacerMutex);
      s_PacerCv.wait_for(
        lock,
        std::chrono::duration_cast<std::chrono::microseconds>(remaining - kPacingSleepFloor)
      );
    } else {
      std::this_thread::yield();
    }
    now = std::chrono::steady_clock::now();
    fromStart = now - s_firstAppend;
  }
}

// Re-anchors the pacing reference to the drift observed between the host
// presentation clock and the local clock.
static void UpdatePacingDrift(TimeStamp fromStart, TimeStamp framePts) {
  if (fromStart <= s_lastSec + kTimeWindow) {
    return;
  }

  if (fromStart > s_lastSec + kTimeWindow * 2) {
    // A long stall left us far behind the window schedule; resync rather than
    // walking forward one window per frame.
    s_lastSec = fromStart;
  } else {
    s_lastSec += kTimeWindow;
  }

  TimeStamp measured = fromStart - framePts;

  if (!s_ptsDiffSeeded) {
    // One-off: lock on to the real offset immediately, so pacing starts working
    // right away instead of creeping towards it a millisecond per second.
    s_ptsDiffSeeded = true;
    s_ptsDiff = measured;
    return;
  }

  TimeStamp step = (measured - s_ptsDiff) * kPacingDriftGain;
  if (step > kPacingMaxDriftStep) {
    step = kPacingMaxDriftStep;
  } else if (step < -kPacingMaxDriftStep) {
    step = -kPacingMaxDriftStep;
  }
  s_ptsDiff += step;
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

    // A gap spanning several frames is a stall or a stream restart, not a
    // cadence error. Folding it in would swamp the standard deviation with one
    // sample and hide the small deviations this exists to expose.
    double frameMs = std::chrono::duration<double, std::milli>(s_frameDuration).count();
    if (intervalMs < frameMs * 4) {
      stats.appendIntervalCount++;
      stats.appendIntervalSumMs += intervalMs;
      stats.appendIntervalSumSqMs += intervalMs * intervalMs;

      if (std::abs(intervalMs - frameMs) > kAppendJitterToleranceMs) {
        stats.appendJitterOutliers++;
      }
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
void MoonlightInstance::RecordPipelineLead(VIDEO_STATS& stats, TimeStamp framePts) {
  int64_t positionUs = g_Instance->m_PipelinePositionUs.load(std::memory_order_acquire);
  if (positionUs == kNoPipelinePosition) {
    // The platform never reported. Leaving the counters at zero makes that
    // visible in the overlay rather than silently reporting a lead of zero,
    // which would look like a measurement.
    return;
  }

  uint64_t reportedAtMs = g_Instance->m_PipelinePositionAtMs.load(std::memory_order_relaxed);
  uint64_t nowMs = LiGetMillis();

  // Extrapolate the reported position to now at real time. Playback rate is
  // never altered here, so 1:1 is exact between updates.
  double sinceReportMs = (nowMs >= reportedAtMs) ? (double)(nowMs - reportedAtMs) : 0.0;
  double positionMs = (positionUs / 1000.0) + sinceReportMs;

  double framePtsMs = std::chrono::duration<double, std::milli>(framePts).count();
  double leadMs = framePtsMs - positionMs;

  stats.pipelineClockSamples++;
  stats.pipelineClockLeadSumMs += leadMs;
  stats.pipelineClockLeadSumSqMs += leadMs * leadMs;

  float absLeadMs = (float)std::abs(leadMs);
  if (absLeadMs > stats.pipelineClockLeadMaxMs) {
    stats.pipelineClockLeadMaxMs = absLeadMs;
  }
}

void MoonlightInstance::VidDecCleanup(void) {
  // Clear the decode buffer
  s_DecodeBuffer.clear();

  // Shrink the decode buffer to fit its contents
  s_DecodeBuffer.shrink_to_fit();
}

int MoonlightInstance::VidDecSubmitDecodeUnit(PDECODE_UNIT decodeUnit) {
  // Check if video playback has not started
  if (!g_Instance->m_VideoStarted) {
    return DR_OK;
  }

  // Get the current time
  auto now = std::chrono::steady_clock::now();

  // Check if this is the first video frame
  if (!s_hasFirstFrame) {
    // Record the time of the first frame
    s_firstAppend = now;
    // Update the flag to indicate that the first frame has been processed
    s_hasFirstFrame = true;
  }

  // Track the total number of bytes received by the decoding unit
  total_bytes += decodeUnit->fullLength;

  // Start performance stats collection if this is the first frame
  if (!m_LastFrameNumber) {
    // Record the timestamp when measurement started
    m_ActiveWndVideoStats.measurementStartTimestamp = LiGetMillis();
    m_LastFrameNumber = decodeUnit->frameNumber;
  } else {
    // Any frame number greater than the last frame number + 1 represents a dropped frame
    m_ActiveWndVideoStats.networkDroppedFrames += decodeUnit->frameNumber - (m_LastFrameNumber + 1);
    m_ActiveWndVideoStats.totalFrames += decodeUnit->frameNumber - (m_LastFrameNumber + 1);
    m_LastFrameNumber = decodeUnit->frameNumber;
  }

  // Calculate the current bitrate in bits per second and then convert the bitrate to megabits per second
  float bitrateMbps = (total_bytes * 8.0) / 1000000.0f;

  // Flip performance stats window roughly every second
  if (m_ActiveWndVideoStats.measurementStartTimestamp + 1000 < LiGetMillis()) {
    // Update performance stats overlay if it's enabled
    if (g_Instance->m_PerformanceStatsEnabled == true) {
      // Create a container to hold aggregated stats for display
      VIDEO_STATS lastTwoWndStats = {};
      // Set the bitrate field in the temporary stats for display purposes
      lastTwoWndStats.receivedBitrate = bitrateMbps;
      // Add last window and current window to the aggregated stats
      AddVideoStats(m_LastWndVideoStats, lastTwoWndStats);
      AddVideoStats(m_ActiveWndVideoStats, lastTwoWndStats);
      // Convert the aggregated stats to a display string
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
      // Reset byte count for the next measurement interval
      total_bytes = 0;
    }
    // Accumulate active window stats into global stats for overall tracking
    AddVideoStats(m_ActiveWndVideoStats, m_GlobalVideoStats);
    // Move current active stats to last window stats and reset active window stats for new interval
    memcpy(&m_LastWndVideoStats, &m_ActiveWndVideoStats, sizeof(m_ActiveWndVideoStats));
    memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));
    m_ActiveWndVideoStats.measurementStartTimestamp = LiGetMillis();
  }

  // Update min host processing latency if a valid value was provided
  if (decodeUnit->frameHostProcessingLatency != 0) {
    // Take the minimum of current min latency and new latency
    if (m_ActiveWndVideoStats.minHostProcessingLatency != 0) {
      m_ActiveWndVideoStats.minHostProcessingLatency = MIN(m_ActiveWndVideoStats.minHostProcessingLatency, decodeUnit->frameHostProcessingLatency);
    } else {
      m_ActiveWndVideoStats.minHostProcessingLatency = decodeUnit->frameHostProcessingLatency;
    }
    // Count how many frames included host processing latency data
    m_ActiveWndVideoStats.framesWithHostProcessingLatency += 1;
  }

  // Update max and total host processing latency
  m_ActiveWndVideoStats.maxHostProcessingLatency = MAX(m_ActiveWndVideoStats.maxHostProcessingLatency, decodeUnit->frameHostProcessingLatency);
  m_ActiveWndVideoStats.totalHostProcessingLatency += decodeUnit->frameHostProcessingLatency;

  // Count the received frame and increment total frames
  m_ActiveWndVideoStats.receivedFrames++;
  m_ActiveWndVideoStats.totalFrames++;

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

  // Declare variables for entry data, offset, and total length
  PLENTRY entry;
  unsigned int offset;
  unsigned int totalLength;

  // Build one packet from multiple data chunks
  totalLength = decodeUnit->fullLength;

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

  // Initialize the entry pointer to the start of the buffer list
  entry = decodeUnit->bufferList;

  // Initialize the offset to 0 before starting to copy data
  offset = 0;

  // Iterate through the buffer list of video data entries
  while (entry != NULL) {
    // Copy the data of the current entry to the decode buffer at the specified offset
    memcpy(&s_DecodeBuffer[offset], entry->data, entry->length);
    // Update the offset based on the length of the copied data
    offset += entry->length;
    // Move to the next entry in the buffer list
    entry = entry->next;
  }

  // Calculate the start of the pacing duration in milliseconds
  uint32_t pacingStart = LiGetMillis();

  // Check if the frame pacing is enabled
  if (s_FramePacingEnabled) {
    // Hold the frame until it is due, then update the pacing reference
    PaceFrame(framePts);
    UpdatePacingDrift(std::chrono::steady_clock::now() - s_firstAppend, framePts);
  }

  // Calculate the end of the pacing duration in milliseconds
  uint32_t pacingEnd = LiGetMillis();

  // Measure total pacer time based on calculated pacing duration
  m_ActiveWndVideoStats.totalPacerTime += pacingEnd - pacingStart;

  // Create an ElementaryMediaPacket and start decoding with the decoded video data
  samsung::wasm::ElementaryMediaPacket pkt {
    framePts, // presentation timestamp
    framePts, // decoding timestamp
    s_frameDuration, // packet duration
    decodeUnit->frameType == FRAME_TYPE_IDR, // packet of frame type
    offset, // packet size
    s_DecodeBuffer.data(), // pointer to packet payload
    s_Width, // packet of width
    s_Height, // packet of height
    s_Framerate, // packet of framerate numerator
    1, // packet of framerate denominator
    g_Instance->m_VideoSessionId.load() // session identifier
  };

  // Track total time spent reassembling and decoding this frame
  m_ActiveWndVideoStats.totalReassemblyTime += decodeUnit->enqueueTimeMs - decodeUnit->receiveTimeMs;
  m_ActiveWndVideoStats.totalDecodeTime += LiGetMillis() - decodeUnit->enqueueTimeMs;
  m_ActiveWndVideoStats.decodedFrames++;

  // Calculate time before rendering
  uint32_t beforeRender = LiGetMillis();

  // Attempt to append the packet to the video track for rendering
  if (g_Instance->m_VideoTrack.AppendPacket(pkt)) {
    // Calculate time after rendering
    uint32_t afterRender = LiGetMillis();
    // Track total render time and count rendered frames
    m_ActiveWndVideoStats.totalRenderTime += afterRender - beforeRender;
    m_ActiveWndVideoStats.renderedFrames++;

    RecordAppendCadence(m_ActiveWndVideoStats);
    RecordPipelineLead(m_ActiveWndVideoStats, framePts);
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
    m_ActiveWndVideoStats.pacerDroppedFrames++;
  }

  return DR_OK;
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
  dst.totalPacerTime += src.totalPacerTime;
  dst.totalRenderTime += src.totalRenderTime;

  // Cadence instrumentation. Sums merge by addition; the max does not.
  dst.appendIntervalCount += src.appendIntervalCount;
  dst.appendIntervalSumMs += src.appendIntervalSumMs;
  dst.appendIntervalSumSqMs += src.appendIntervalSumSqMs;
  dst.appendJitterOutliers += src.appendJitterOutliers;
  dst.pipelineClockSamples += src.pipelineClockSamples;
  dst.pipelineClockLeadSumMs += src.pipelineClockLeadSumMs;
  dst.pipelineClockLeadSumSqMs += src.pipelineClockLeadSumSqMs;
  dst.pipelineClockLeadMaxMs = MAX(dst.pipelineClockLeadMaxMs, src.pipelineClockLeadMaxMs);

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
  int ret;
  int offset = 0;
  const char* codecString;

  // Start with an empty string
  output[offset] = 0;

  // Determine the video format being used and assign a readable string
  switch (s_VideoFormat) {
    case VIDEO_FORMAT_H264: // H.264 codec
      codecString = "H.264";
      break;
    case VIDEO_FORMAT_H265: // HEVC codec
      codecString = "HEVC";
      break;
    case VIDEO_FORMAT_H265_MAIN10: // HEVC Main10 codec
      if (LiGetCurrentHostDisplayHdrMode()) {
        codecString = "HEVC 10-bit HDR";
      } else {
        codecString = "HEVC 10-bit SDR";
      }
      break;
    case VIDEO_FORMAT_AV1_MAIN8: // AV1 codec
      codecString = "AV1";
      break;
    case VIDEO_FORMAT_AV1_MAIN10: // AV1 Main10 codec
      if (LiGetCurrentHostDisplayHdrMode()) {
        codecString = "AV1 10-bit HDR";
      } else {
        codecString = "AV1 10-bit SDR";
      }
      break;
    default: // Unknown codec
      assert(false);
      codecString = "UNKNOWN";
      break;
  }

  // If there is a meaningful received frame rate, print basic stream info
  if (stats.receivedFps > 0) {
    if (codecString != nullptr) {
      // Print video resolution, frame rate, and codec name
      ret = snprintf(
        &output[offset], length - offset,
        "Video stream: %dx%d %.2f FPS (Codec: %s)\n",
        s_Width, s_Height, stats.totalFps, codecString
      );
      // Abort if string formatting failed or buffer overflowed
      if (ret < 0 || ret >= length - offset) {
        assert(false);
        return;
      }
      offset += ret;
    }

    // Print frame rates at various stages of the pipeline
    ret = snprintf(
      &output[offset], length - offset,
      "Incoming frame rate from network: %.2f FPS\n"
      "Decoding frame rate: %.2f FPS\n"
      "Rendering frame rate: %.2f FPS\n"
      "Incoming bitrate from network: %.2f Mbps\n",
      stats.receivedFps, stats.decodedFps, stats.renderedFps, stats.receivedBitrate
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Only display host processing latency if latency data exists
  if (stats.framesWithHostProcessingLatency > 0) {
    // Print min, max, and average host processing latency in milliseconds
    ret = snprintf(
      &output[offset], length - offset,
      "Host processing latency min/max/average: %.1f/%.1f/%.1f ms\n",
      (float)stats.minHostProcessingLatency / 10, (float)stats.maxHostProcessingLatency / 10,
      (float)stats.totalHostProcessingLatency / 10 / stats.framesWithHostProcessingLatency
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Show remaining statistics only if some frames have been rendered
  if (stats.renderedFrames != 0) {
    char rttString[32];
    // Format the round-trip time string
    if (stats.lastRtt != 0) {
      // Print the last RTT including variance in milliseconds
      snprintf(
        rttString, sizeof(rttString),
        "%u ms (variance: %u ms)",
        stats.lastRtt, stats.lastRttVariance
      );
    } else {
      // Otherwise, print as "N/A" if RTT is unavailable
      snprintf(rttString, sizeof(rttString), "N/A");
    }

    // Print detailed drop rates and timing statistics
    ret = snprintf(
      &output[offset], length - offset,
      "Frames dropped by your network connection: %.2f%%\n"
      "Frames dropped due to network jitter: %.2f%%\n"
      "Average network latency: %s\n"
      "Average decoding time: %.2f ms\n"
      "Average frame queue delay: %.2f ms\n"
      "Average rendering time: %.2f ms\n",
      (float)stats.networkDroppedFrames / stats.totalFrames * 100,
      (float)stats.pacerDroppedFrames / stats.decodedFrames * 100,
      rttString,
      (float)stats.totalDecodeTime / stats.decodedFrames,
      (float)stats.totalPacerTime / stats.renderedFrames,
      (float)stats.totalRenderTime / stats.renderedFrames
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Cadence block. Everything above is a mean, and a mean cannot distinguish a
  // steady 60 FPS from a 60 FPS that arrives in bursts. These three lines can.
  if (stats.appendIntervalCount > 1) {
    double n = (double)stats.appendIntervalCount;
    double mean = stats.appendIntervalSumMs / n;
    // Population variance from the running sums. Clamped at zero because
    // catastrophic cancellation can drive it slightly negative when every
    // sample is nearly identical, which is exactly the good case.
    double variance = (stats.appendIntervalSumSqMs / n) - (mean * mean);
    if (variance < 0.0) {
      variance = 0.0;
    }

    ret = snprintf(
      &output[offset], length - offset,
      "Frame delivery interval: %.2f ms average, %.2f ms deviation\n"
      "Frames delivered off cadence (>%.0f ms): %.2f%%\n",
      mean, sqrt(variance), kAppendJitterToleranceMs,
      (float)stats.appendJitterOutliers / (float)stats.appendIntervalCount * 100
    );
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Pipeline buffer depth. Absent means the platform never reported a position,
  // which is itself the answer to whether we can pace against its clock.
  if (stats.pipelineClockSamples > 1) {
    double n = (double)stats.pipelineClockSamples;
    double mean = stats.pipelineClockLeadSumMs / n;
    double variance = (stats.pipelineClockLeadSumSqMs / n) - (mean * mean);
    if (variance < 0.0) {
      variance = 0.0;
    }

    ret = snprintf(
      &output[offset], length - offset,
      "Pipeline buffer depth: %.1f ms average, %.1f ms deviation, %.1f ms peak\n",
      mean, sqrt(variance), stats.pipelineClockLeadMaxMs
    );
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  } else if (stats.renderedFrames != 0) {
    ret = snprintf(
      &output[offset], length - offset,
      "Pipeline buffer depth: not reported by the platform\n"
    );
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }
}

void MoonlightInstance::TogglePerformanceStats() {
  // Toggle the performance stats overlay flag
  m_PerformanceStatsEnabled = !m_PerformanceStatsEnabled;

  // Notify the JS code that performance stats overlay is enabled or disabled
  if (m_PerformanceStatsEnabled) {
    PostToJs(std::string("StatMsg: ") + s_StatString.data());
  } else {
    PostToJs(std::string("NoStatMsg: "));
  }
}

void MoonlightInstance::WaitFor(std::condition_variable* variable, std::function<bool()> condition) {
  std::unique_lock<std::mutex> lock(m_Mutex);
  variable->wait(lock, [&]() { return m_ConnectionCancelled.load() || condition(); });
}

DECODER_RENDERER_CALLBACKS MoonlightInstance::s_DrCallbacks = {
  .setup = MoonlightInstance::VidDecSetup,
  .cleanup = MoonlightInstance::VidDecCleanup,
  .submitDecodeUnit = MoonlightInstance::VidDecSubmitDecodeUnit,
  // One slice per frame. Slicing exists to let a multithreaded software decoder
  // work on a frame in parallel; this pipeline hands the bitstream to the TV's
  // hardware decoder, where extra slices only add bitstream overhead and cost
  // compression efficiency at the same bitrate.
  .capabilities = CAPABILITY_SLICES_PER_FRAME(1),
};
