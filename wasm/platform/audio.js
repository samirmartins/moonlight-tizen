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

// Ring of AudioBuffers, reused rather than allocated per frame.
//
// At a hundred frames a second, allocating a buffer per frame is a hundred
// objects a second for the collector to reclaim, on the same thread that has to
// stay free for video. A buffer whose samples are overwritten while a live
// source node is still reading it would glitch, so the ring is sized far deeper
// than the number of frames that can be scheduled ahead: the jitter target
// bounds that at a few frames, and this holds thirty-two.
var _AUD_POOL_DEPTH = 32;
var _audPool = null;
var _audPoolIdx = 0;
// Shape the pool was built for. A change means the stream was renegotiated and
// the pool has to be rebuilt.
var _audPoolChannels = 0;
var _audPoolFrames = 0;
var _audPoolRate = 0;

function _audBuildPool(ctx, channels, spf, sampleRate) {
  _audPool = new Array(_AUD_POOL_DEPTH);
  for (var i = 0; i < _AUD_POOL_DEPTH; i++) {
    _audPool[i] = ctx.createBuffer(channels, spf, sampleRate);
  }
  _audPoolIdx = 0;
  _audPoolChannels = channels;
  _audPoolFrames = spf;
  _audPoolRate = sampleRate;
}

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
  var targetS = (window._mlAudioTargetMs || 60) / 1000.0;

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
  // every frame, which is expensive at a hundred frames per second. Report it
  // once; the context is requested at 48 kHz to match Opus, so this should not
  // fire.
  if (!_audLoggedRateMismatch && ctx.sampleRate !== sampleRate) {
    _audLoggedRateMismatch = true;
    console.warn('%c[audio.js, _audReceiveFrame]', 'color: gray;',
      'AudioContext runs at ' + ctx.sampleRate + ' Hz but frames are ' + sampleRate +
      ' Hz; every buffer will be resampled.');
  }

  if (_audPool === null || _audPoolChannels !== channels ||
      _audPoolFrames !== spf || _audPoolRate !== sampleRate) {
    _audBuildPool(ctx, channels, spf, sampleRate);
  }

  var abuf = _audPool[_audPoolIdx];
  _audPoolIdx = (_audPoolIdx + 1) % _AUD_POOL_DEPTH;

  // Hoist the heap view and the scale factor out of the inner loop. Reading
  // Module.HEAP16 per sample is a property lookup per sample, and at 48 kHz
  // stereo that is ten thousand of them a second on the main thread.
  var heap = Module.HEAP16;
  var base = ptr >> 1; // byte offset to int16 index
  var scale = 1.0 / 32768.0;

  for (var c = 0; c < channels; c++) {
    var cd = abuf.getChannelData(c);
    var src = base + c;
    for (var i = 0; i < spf; i++) {
      cd[i] = heap[src] * scale;
      src += channels;
    }
  }

  // A source node cannot be reused: the specification allows start() once per
  // node, so this allocation is unavoidable. Only the buffer is pooled.
  var srcNode = ctx.createBufferSource();
  srcNode.buffer = abuf;
  srcNode.connect(ctx.destination);
  srcNode.start(_audNextTime);
  _audNextTime += abuf.duration;
}

function startAudioScheduler() {
  _audNextTime = 0.0;
  _audLoggedRateMismatch = false;
  // The pool is tied to an AudioContext, which is recreated per stream
  _audPool = null;
  _audPoolChannels = _audPoolFrames = _audPoolRate = 0;
}

function stopAudioScheduler() {
  _audNextTime = 0.0;
  _audPool = null;
  _audPoolChannels = _audPoolFrames = _audPoolRate = 0;
}
