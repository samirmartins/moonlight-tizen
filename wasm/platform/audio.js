// Web Audio scheduler.
//
// The feeder thread in wasm/auddec.cpp decodes each Opus frame and calls
// _audReceiveFrame() on the main thread through MAIN_THREAD_ASYNC_EM_ASM. There
// is no polling here: frames are scheduled as they arrive, so timer throttling
// while a TV overlay is open cannot interrupt playback.
//
// startAudioScheduler() and stopAudioScheduler() are called from index.js and
// messages.js to reset state around the stream lifetime.

// Start time of the next buffer, on the AudioContext clock
var _audNextTime = 0.0;

// One-shot log guards, so a mismatch reports once rather than per frame
var _audLoggedRateMismatch = false;

// Called by the C++ feeder thread for each decoded frame.
//   ptr        - byte offset of interleaved int16 PCM in the WASM heap
//   spf        - samples per frame, per channel
//   channels   - channel count
//   sampleRate - Hz, as negotiated with the host
function _audReceiveFrame(ptr, spf, channels, sampleRate) {
  var ctx = window._mlAudioCtx;
  if (!ctx) {
    return;
  }

  if (ctx.state === 'suspended') {
    try { ctx.resume(); } catch (e) {}
    // Drop this frame; _audNextTime realigns on the next one after resuming
    return;
  }

  var now = ctx.currentTime;
  var targetS = (window._mlAudioTargetMs || 100) / 1000.0;

  // Behind the clock, at startup or after a gap: realign
  if (_audNextTime < now) {
    _audNextTime = now;
  }

  // Already a full jitter buffer ahead: drop. This absorbs the stale bursts
  // that pile up in the async task queue while the main thread is throttled.
  if (_audNextTime > now + targetS) {
    return;
  }

  // A buffer created at a rate the context does not run at is resampled on
  // every frame, which is expensive at 100 frames per second. Report it once;
  // the context is requested at 48 kHz to match Opus, so this should not fire.
  if (!_audLoggedRateMismatch && ctx.sampleRate !== sampleRate) {
    _audLoggedRateMismatch = true;
    console.warn('%c[audio.js, _audReceiveFrame]', 'color: gray;',
      'AudioContext runs at ' + ctx.sampleRate + ' Hz but frames are ' + sampleRate +
      ' Hz; every buffer will be resampled.');
  }

  var abuf = ctx.createBuffer(channels, spf, sampleRate);
  var base = ptr >> 1; // byte offset to int16 index
  for (var c = 0; c < channels; c++) {
    var cd = abuf.getChannelData(c);
    for (var i = 0; i < spf; i++) {
      cd[i] = Module.HEAP16[base + i * channels + c] / 32768.0;
    }
  }

  var src = ctx.createBufferSource();
  src.buffer = abuf;
  src.connect(ctx.destination);
  src.start(_audNextTime);
  _audNextTime += abuf.duration;
}

function startAudioScheduler() {
  _audNextTime = 0.0;
  _audLoggedRateMismatch = false;
}

function stopAudioScheduler() {
  _audNextTime = 0.0;
}
