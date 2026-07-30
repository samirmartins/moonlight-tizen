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

// How far ahead of its presentation time a frame is handed over, in frame
// durations.
//
// Releasing a frame exactly when it is due leaves the pipeline with nothing in
// hand, so any hesitation upstream lands directly on the screen. The other
// clients keep a shallow buffer past the decoder for precisely this reason:
// moonlight-android holds its output queue at two frames and presents one per
// display refresh. One frame of lead is the same idea expressed where this
// pipeline allows it, and it costs one frame of latency.
static constexpr int kPacingLeadFrames = 1;

// Per-second correction applied to the pacing reference. It is a small
// proportional step rather than an instant jump: assigning the whole measured
// drift at once releases every frame being held in a single burst, which is
// visible as a hitch roughly once per second.
static constexpr double kPacingDriftGain = 0.1;
static constexpr TimeStamp kPacingMaxDriftStep = 1ms;

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

static uint32_t s_VideoFormat = 0;
static uint32_t s_Width = 0;
static uint32_t s_Height = 0;
static uint32_t s_Framerate = 0;

static std::vector<unsigned char> s_DecodeBuffer;

static TimeStamp s_frameDuration;
static TimeStamp s_pktPts;

static TimeStamp s_lastSec;

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

// An interval this far from one frame duration counts as an outlier. A quarter
// of a frame at 60 Hz is about 4 ms, which is roughly where a cadence error
// stops being invisible.
static constexpr double kAppendJitterToleranceMs = 4.0;

static bool s_hasFirstFrame = false;

static uint32_t s_lastIdrRequestMs = 0;

// PostToJsAsync() hands a raw pointer to the main thread and returns before the
// main thread reads it, so the payload has to outlive the call. Only the video
// decoder thread writes this, and only once per second.
static std::string s_PendingStatMsg;

static uint32_t total_bytes = 0;
static int m_LastFrameNumber = 0;

static std::string s_StatString = "";

// Defined below, next to the recovery worker they control.
static void StartRecoveryThread();
static void StopRecoveryThread();

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

  // Flag indicating whether this is the first frame of video to be decoded
  s_hasFirstFrame = false;

  // Initialize the last second timestamp to zero
  s_lastSec = 0s;

  // Initialize the timestamp difference to zero


  // Reset the generated timeline for the new stream
  s_hasHostPtsRef = false;
  s_lastHostPtsMs = 0;
  s_loggedPtsSource = false;
  s_ptsStep = s_frameDuration;
  s_ptsFrameNumberRef = 0;
  s_ptsWindowHostMs = 0;
  s_ptsWindowFrames = 0;

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

  // Reset global video statistics for new decoding session
  memset(&m_GlobalVideoStats, 0, sizeof(m_GlobalVideoStats));

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
  {
    double hostDeltaMs =
      (double)((int64_t)hostMs - (int64_t)s_lastHostPtsMs) / framesElapsed;
    double frameMs = std::chrono::duration<double, std::milli>(s_frameDuration).count();
    if (hostDeltaMs > 0.0 && hostDeltaMs < frameMs * 4) {
      m_ActiveWndVideoStats.hostIntervalCount++;
      m_ActiveWndVideoStats.hostIntervalSumMs += hostDeltaMs;
      m_ActiveWndVideoStats.hostIntervalSumSqMs += hostDeltaMs * hostDeltaMs;
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

  return previousPts + s_ptsStep * framesElapsed;
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

  LiRequestIdrFrame();
}

// Called after every accepted append. Cheap by construction: two atomic loads
// and some integer arithmetic on the thread that is already here.
void MoonlightInstance::NotePresentationProgress(TimeStamp framePts) {
  (void)framePts;

  const int64_t positionUs =
    g_Instance->m_PipelinePositionUs.load(std::memory_order_acquire);
  const uint32_t nowMs = LiGetMillis();

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
  m_ActiveWndVideoStats.presentationRecoveries++;

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

int MoonlightInstance::VidDecSubmitDecodeUnit(PDECODE_UNIT decodeUnit) {
  // Check if video playback has not started
  if (!g_Instance->m_VideoStarted) {
    return DR_OK;
  }

  // Get the current time
  auto now = std::chrono::steady_clock::now();

  // Check if this is the first video frame
  if (!s_hasFirstFrame) {
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

  // Assemble the packet.
  //
  // A decode unit that arrived as a single contiguous entry needs no assembly at
  // all: the buffer belongs to the decoder thread until AppendPacket returns, so
  // the platform can read it where it lies. That is every P-frame, which is all
  // but one frame in sixty. Only an IDR arrives split into parameter sets and
  // picture data, and only that path pays for a copy, which it needs anyway
  // because the H.264 SPS is rewritten in transit.
  PLENTRY entry = decodeUnit->bufferList;
  unsigned int offset;
  const unsigned char* packetData;

  const bool needsSpsFixup = (decodeUnit->frameType == FRAME_TYPE_IDR) &&
                             (s_VideoFormat & VIDEO_FORMAT_H264);

  if (!needsSpsFixup && entry != NULL && entry->next == NULL &&
      entry->length == decodeUnit->fullLength) {
    packetData = reinterpret_cast<const unsigned char*>(entry->data);
    offset = (unsigned int)decodeUnit->fullLength;
    m_ActiveWndVideoStats.zeroCopyFrames++;
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

  // Track total time spent reassembling and decoding this frame
  m_ActiveWndVideoStats.totalReassemblyTime += decodeUnit->enqueueTimeMs - decodeUnit->receiveTimeMs;
  m_ActiveWndVideoStats.totalDecodeTime += LiGetMillis() - decodeUnit->enqueueTimeMs;
  m_ActiveWndVideoStats.decodedFrames++;

  // Calculate time before rendering
  uint32_t beforeRender = LiGetMillis();

  // Hand the packet over.
  //
  // There is no retry loop. This now runs on the thread that drains the socket,
  // and holding it for a further attempt would trade a lost frame for lost
  // packets, which is the worse of the two.
  const bool appended = (bool)g_Instance->m_VideoTrack.AppendPacket(pkt);

  if (appended) {
    // Calculate time after rendering
    uint32_t afterRender = LiGetMillis();
    // Track total render time and count rendered frames
    m_ActiveWndVideoStats.totalRenderTime += afterRender - beforeRender;
    m_ActiveWndVideoStats.renderedFrames++;

    RecordAppendCadence(m_ActiveWndVideoStats);
    RecordPipelineLead(m_ActiveWndVideoStats, framePts);
    NotePresentationProgress(framePts);
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
  dst.hostIntervalCount += src.hostIntervalCount;
  dst.hostIntervalSumMs += src.hostIntervalSumMs;
  dst.hostIntervalSumSqMs += src.hostIntervalSumSqMs;
  dst.pipelineClockSamples += src.pipelineClockSamples;
  dst.pipelineClockLeadSumMs += src.pipelineClockLeadSumMs;
  dst.pipelineClockLeadSumSqMs += src.pipelineClockLeadSumSqMs;
  dst.pipelineClockLeadMaxMs = MAX(dst.pipelineClockLeadMaxMs, src.pipelineClockLeadMaxMs);
  dst.zeroCopyFrames += src.zeroCopyFrames;
  dst.appendRetries += src.appendRetries;
  dst.presentationRecoveries += src.presentationRecoveries;

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

    // Same spread as measured by the host itself. If this matches the line
    // above, the stream arrived as unevenly as it was sent and there is nothing
    // left here to fix.
    if (stats.hostIntervalCount > 1) {
      double hn = (double)stats.hostIntervalCount;
      double hmean = stats.hostIntervalSumMs / hn;
      double hvar = (stats.hostIntervalSumSqMs / hn) - (hmean * hmean);
      if (hvar < 0.0) {
        hvar = 0.0;
      }
      ret = snprintf(
        &output[offset], length - offset,
        "Host send interval: %.2f ms average, %.2f ms deviation\n",
        hmean, sqrt(hvar)
      );
    } else {
      ret = 0;
    }
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Assembly and hand-over behaviour. Each of these three is zero in the healthy
  // case except the first, which should be nearly every frame.
  if (stats.decodedFrames != 0) {
    ret = snprintf(
      &output[offset], length - offset,
      "Frames submitted without assembly: %.1f%%\n"
      "Hand-over retries: %u, pipeline recoveries: %u\n",
      (float)stats.zeroCopyFrames / (float)stats.decodedFrames * 100,
      stats.appendRetries, stats.presentationRecoveries
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
