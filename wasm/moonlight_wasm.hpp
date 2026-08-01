#include <atomic>
#include <memory>
#include <emscripten/bind.h>
#include <emscripten/html5.h>
#include <emscripten/val.h>
#include <pthread.h>
#include <string>

#include <Limelight.h>
#include "lib.hpp"

#include "samsung/wasm/elementary_media_stream_source.h"
#include "samsung/wasm/elementary_media_stream_source_listener.h"
#include "samsung/wasm/elementary_media_track.h"
#include "samsung/wasm/elementary_media_track_listener.h"
#include "samsung/html/html_media_element.h"
#include "samsung/html/html_media_element_listener.h"

#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))

struct MessageResult {
  std::string type;
  emscripten::val ret;

  MessageResult(std::string t = "", emscripten::val r = emscripten::val::null())
    : type(t), ret(r) {}

  static MessageResult Resolve(emscripten::val r = emscripten::val::null()) {
    return {"resolve", r};
  }
  static MessageResult Reject(emscripten::val r = emscripten::val::null()) {
    return {"reject", r};
  }
};

typedef struct _VIDEO_STATS {
  uint32_t receivedFrames;
  uint32_t decodedFrames;
  uint32_t renderedFrames;
  uint32_t totalFrames;
  uint32_t networkDroppedFrames;
  uint32_t pacerDroppedFrames;
  uint16_t minHostProcessingLatency;
  uint16_t maxHostProcessingLatency;
  uint32_t totalHostProcessingLatency;
  uint32_t framesWithHostProcessingLatency;
  uint32_t totalReassemblyTime;
  uint32_t totalDecodeTime;
  uint32_t totalRenderTime;
  uint32_t lastRtt;
  uint32_t lastRttVariance;
  float totalFps;
  float receivedFps;
  float decodedFps;
  float renderedFps;
  float receivedBitrate;
  uint32_t measurementStartTimestamp;

  // Cadence instrumentation.
  //
  // Every other counter above is a mean over a one second window, and a mean is
  // blind to the thing we are chasing: a cadence can average exactly 60 FPS and
  // still deliver every frame at the wrong moment. These fields carry enough to
  // reconstruct the spread, not just the centre.
  //
  // Sums are kept instead of the derived statistics so that AddVideoStats() can
  // merge two windows by addition, like every other field here.
  uint32_t appendIntervalCount;     // inter-append intervals measured
  double appendIntervalSumMs;       // sum, for the mean
  double appendIntervalSumSqMs;     // sum of squares, for the standard deviation
  uint32_t appendJitterOutliers;    // intervals outside the tolerance window

  // The same spread, measured on the host's own timestamps instead of on when
  // the frame reached us. Side by side the two separate a stream the host
  // delivered unevenly from one this client made uneven, which is the one thing
  // the overlay could never tell before.
  uint32_t hostIntervalCount;
  double hostIntervalSumMs;
  double hostIntervalSumSqMs;

  // Distance between the timestamp we hand to the pipeline and where the
  // pipeline reports it actually is. This is the depth of the TV's own buffer:
  // if it grows, the pipeline is queueing our frames rather than presenting
  // them on arrival, and pacing the submission cannot control presentation.
  uint32_t pipelineClockSamples;
  double pipelineClockLeadSumMs;
  double pipelineClockLeadSumSqMs;
  float pipelineClockLeadMaxMs;

  // Frames handed to the platform where they already lay, without assembly
  uint32_t zeroCopyFrames;
  // Times the pipeline was flushed because presentation had stopped advancing
  // while packets were still being accepted
  uint32_t presentationRecoveries;
} VIDEO_STATS, *PVIDEO_STATS;

enum class LoadResult {
  Success, CertErr, PrivateKeyErr
};

constexpr const char* kCanvasName = "#wasm_module";

class MoonlightInstance {
  public:
  explicit MoonlightInstance();

  MessageResult StartStream(std::string host, int httpPort, std::string width, std::string height, std::string fps, std::string bitrate,
    std::string rikey, std::string rikeyid, std::string appversion, std::string gfeversion, std::string rtspurl, int serverCodecModeSupport,
    bool framePacing, bool optimizeGames, bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons,
    std::string audioConfig, int audioJitterMs, bool playHostAudio, std::string videoCodec, bool hdrMode, bool fullRange, bool gameMode,
    bool disableWarnings, bool performanceStats, int clientRefreshRateX100);
  MessageResult StopStream();

  MessageResult CancelRequest();

  void STUN(int callbackId);
  void Pair(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber);
  void WakeOnLan(int callbackId, std::string macAddress);

  virtual ~MoonlightInstance();

  bool Init(uint32_t argc, const char* argn[], const char* argv[]);

  EM_BOOL HandleMouseDown(const EmscriptenMouseEvent& event);
  EM_BOOL HandleMouseMove(const EmscriptenMouseEvent& event);
  EM_BOOL HandleMouseUp(const EmscriptenMouseEvent& event);
  EM_BOOL HandleWheel(const EmscriptenWheelEvent& event);
  EM_BOOL HandleKeyDown(const EmscriptenKeyboardEvent& event);
  EM_BOOL HandleKeyUp(const EmscriptenKeyboardEvent& event);

  void ReportMouseMovement();

  void HandleGamepadInputState(bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons);
  void PollGamepads();

  void MouseLockLost();
  void DidLockMouse(int32_t result);

  void OnConnectionStopped(uint32_t unused);
  void OnConnectionStarted(uint32_t error);
  void StopConnection();

  static void* ConnectionThreadFunc(void* context);
  static void* InputThreadFunc(void* context);
  static void* StopThreadFunc(void* context);

  static void ClStageStarting(int stage);
  static void ClStageFailed(int stage, int errorCode);
  static void ClConnectionStarted(void);
  static void ClConnectionTerminated(int errorCode);
  static void ClDisplayMessage(const char* message);
  static void ClDisplayTransientMessage(const char* message);
  static void ClLogMessage(const char* format, ...);
  static void ClControllerRumble(unsigned short controllerNumber, unsigned short lowFreqMotor, unsigned short highFreqMotor);
  static void ClConnectionStatusUpdate(int connectionStatus);

  void DidChangeFocus(bool got_focus);
  bool InitializeRenderingSurface(int width, int height);

  static int VidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags);
  static int StartupVidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags);
  static void VidDecCleanup(void);
  static int VidDecSubmitDecodeUnit(PDECODE_UNIT decodeUnit);
  static void AddVideoStats(VIDEO_STATS& src, VIDEO_STATS& dst);
  static void FormatVideoStats(VIDEO_STATS& stats, char* output, int length);
  // Cadence instrumentation, fed from the frame submission path.
  static void RecordAppendCadence(VIDEO_STATS& stats);
  static void RecordPipelineLead(VIDEO_STATS& stats, samsung::wasm::Seconds framePts);
  // Watches for the pipeline accepting packets while presentation is frozen, and
  // asks the recovery worker to flush when it is.
  static void NotePresentationProgress(samsung::wasm::Seconds framePts);
  // Entry point for the recovery worker, which is a free function and so cannot
  // reach the media source directly.
  static void PerformPresentationRecovery();
  void TogglePerformanceStats();
  bool PerformanceStatsEnabled() const {
    return m_PerformanceStatsEnabled.load(std::memory_order_relaxed);
  }

  static int AudDecInit(int audioConfiguration, POPUS_MULTISTREAM_CONFIGURATION opusConfig, void* context, int arFlags);
  static void AudDecCleanup(void);
  static void AudDecDecodeAndPlaySample(char* sampleData, int sampleLength);

  MessageResult MakeCert();

  MessageResult HttpInit(std::string cert, std::string privateKey, std::string myUniqueId);
  void OpenUrl(int callbackId, std::string url, std::string ppk, bool binaryResponse);

  LoadResult LoadCert(const char* certStr, const char* keyStr);

  // Last playback position reported by the pipeline, and the local time it was
  // reported at, so a reader can extrapolate to now. Microseconds rather than a
  // floating point second count because std::atomic<double> is not guaranteed
  // to be lock free here, and this is written from the main thread and read
  // from the decoder thread on every frame.
  //
  // A negative position means the pipeline has not reported yet. Everything
  // downstream must treat that as "no measurement", never as position zero.
  static constexpr int64_t kNoPipelinePosition = -1;
  std::atomic<int64_t> m_PipelinePositionUs;
  std::atomic<uint64_t> m_PipelinePositionAtMs;

  private:
    using EmssReadyState = samsung::wasm::ElementaryMediaStreamSource::ReadyState;
    using EmssTrackCloseReason = samsung::wasm::ElementaryMediaTrack::CloseReason;
  class SourceListener
    : public samsung::wasm::ElementaryMediaStreamSourceListener {
  public:
    SourceListener(MoonlightInstance* instance);
    void OnSourceOpen() override;
    void OnSourceOpenPending() override;
    void OnSourceClosed() override;
    // The pipeline's own clock. Samsung documents this as the preferred way to
    // receive time updates, and it is the only observable that tells us where
    // the TV actually is in the stream rather than where we assume it is.
    void OnPlaybackPositionChanged(samsung::wasm::Seconds) override;
  private:
    MoonlightInstance* m_Instance;
  };
  class VideoTrackListener
    : public samsung::wasm::ElementaryMediaTrackListener {
  public:
    VideoTrackListener(MoonlightInstance* instance);
    void OnTrackOpen() override;
    void OnTrackClosed(EmssTrackCloseReason) override;
    void OnSessionIdChanged(samsung::wasm::SessionId new_session_id) override;
  private:
    MoonlightInstance* m_Instance;
  };

  void WaitFor(std::condition_variable* variable, std::function<bool()> condition);

  void OpenUrl_private(int callbackId, std::string url, std::string ppk, bool binaryResponse);
  void STUN_private(int callbackId);
  void Pair_private(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber);

  void LockMouse();
  void UnlockMouse();

  static CONNECTION_LISTENER_CALLBACKS s_ClCallbacks;
  static DECODER_RENDERER_CALLBACKS s_DrCallbacks;
  static AUDIO_RENDERER_CALLBACKS s_ArCallbacks;

  std::string m_Host;
  std::string m_AppVersion;
  std::string m_GfeVersion;
  std::string m_RtspUrl;
  int m_AudioJitterMs;
  bool m_DisableWarningsEnabled;
  std::atomic<bool> m_PerformanceStatsEnabled;

  STREAM_CONFIGURATION m_StreamConfig;
  std::atomic<bool> m_Running;

  pthread_t m_ConnectionThread;
  pthread_t m_InputThread;

  bool m_MouseLocked;
  long m_MouseLastPosX;
  long m_MouseLastPosY;
  bool m_WaitingForAllModifiersUp;
  std::atomic<int32_t> m_AccumulatedTicks;
  std::atomic<int32_t> m_MouseDeltaX, m_MouseDeltaY;
  Dispatcher m_Dispatcher;

  std::mutex m_Mutex;
  std::condition_variable m_EmssStateChanged;
  std::condition_variable m_EmssVideoStateChanged;
  EmssReadyState m_EmssReadyState;
  std::atomic<bool> m_VideoStarted;
  std::atomic<bool> m_ConnectionCancelled;
  pthread_t m_StopThread;
  std::atomic<bool> m_StopNeedsLiStop;
  std::atomic<samsung::wasm::SessionId> m_VideoSessionId;


  samsung::html::HTMLMediaElement m_MediaElement;
  std::unique_ptr<samsung::wasm::ElementaryMediaStreamSource> m_Source;
  SourceListener m_SourceListener;
  VideoTrackListener m_VideoTrackListener;
  samsung::wasm::ElementaryMediaTrack m_VideoTrack;
  std::atomic<bool> m_SourceClosed;
  std::condition_variable m_SourceClosedCV;
};

extern MoonlightInstance* g_Instance;

void PostToJs(std::string msg);
void PostToJsAsync(const std::string& msg);
void NotifyInputEvent();
void WaitForInputEvent(uint32_t& observedGeneration, int timeoutMs);
bool InputNeedsTimedWake();
void PostPromiseMessage(int callbackId, const std::string& type, const std::string& response);
void PostPromiseMessage(int callbackId, const std::string& type, const std::vector<uint8_t>& response);

MessageResult makeCert();

MessageResult httpInit(std::string cert, std::string privateKey, std::string myUniqueId);
void openUrl(int callbackId, std::string url, emscripten::val ppk, bool binaryResponse);

MessageResult startStream(std::string host, int httpPort, std::string width, std::string height, std::string fps, std::string bitrate,
  std::string rikey, std::string rikeyid, std::string appversion, std::string gfeversion, std::string rtspurl, int serverCodecModeSupport,
  bool framePacing, bool optimizeGames, bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons,
  std::string audioConfig, int audioJitterMs, bool playHostAudio, std::string videoCodec, bool hdrMode, bool fullRange, bool gameMode,
  bool disableWarnings, bool performanceStats, int clientRefreshRateX100);
MessageResult stopStream();

MessageResult cancelRequest();

void toggleStats();
void stun(int callbackId);
void pair(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber, std::string uniqueId);
void wakeOnLan(int callbackId, std::string macAddress);

EM_BOOL handleKeyDown(int eventType, const EmscriptenKeyboardEvent* keyEvent, void* userData);
EM_BOOL handleKeyUp(int eventType, const EmscriptenKeyboardEvent* keyEvent, void* userData);
EM_BOOL handleMouseMove(int eventType, const EmscriptenMouseEvent* keyEvent, void* userData);
EM_BOOL handleMouseUp(int eventType, const EmscriptenMouseEvent* keyEvent, void* userData);
EM_BOOL handleMouseDown(int eventType, const EmscriptenMouseEvent* keyEvent, void* userData);
EM_BOOL handleWheel(int eventType, const EmscriptenWheelEvent* keyEvent, void* userData);
EM_BOOL handlePointerLockChange(int eventType, const EmscriptenPointerlockChangeEvent *pointerlockChangeEvent, void *userData);
EM_BOOL handlePointerLockError(int eventType, const void *reserved, void *userData);

void onConnectionStarted();
void onConnectionStopped(int errorCode);
