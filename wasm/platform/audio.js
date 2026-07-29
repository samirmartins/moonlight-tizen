// Web Audio scheduler.
//
// The feeder thread in wasm/auddec.cpp decodes each Opus frame and calls
// _audReceiveFrame() on the main thread through MAIN_THREAD_ASYNC_EM_ASM. There
// is no polling here: frames are scheduled as they arrive, so timer throttling
// while a TV overlay is open cannot interrupt playback.
//
// Three mechanisms keep the output continuous without letting latency grow:
//
//   * a rate servo, which consumes PCM slightly faster or slower than it
//     arrives to hold the buffer at its target instead of throwing frames away
//   * an A/V drift loop, which compares where the video pipeline says it is
//     against how much audio has actually been played
//   * a seqlock on each PCM slot, so a frame whose samples were overwritten
//     mid-copy is counted and discarded rather than played as a splice
//
// configureAudioScheduler(), startAudioScheduler() and stopAudioScheduler() are
// called from wasm/auddec.cpp, index.js and messages.js around the stream
// lifetime.

// ─── Rate servo tuning ───────────────────────────────────────────────────────
//
// The servo changes playback rate, which changes pitch. A tenth of a percent is
// about two cents, so the ceilings below are chosen to stay under what an ear
// notices on sustained tones while still being able to recover a backlog in a
// reasonable time.
//
// Draining is allowed more authority than filling, because a buffer that is too
// deep costs latency continuously while a buffer that is too shallow is only a
// risk. One percent clears a hundred milliseconds of backlog in ten seconds.
var _AUD_RATE_MAX = 1.010;      // consume up to 1% faster than arrival
var _AUD_RATE_MIN = 0.995;      // and up to 0.5% slower
var _AUD_DRAIN_GAIN = 0.20;     // per second of excess over the target
var _AUD_DRAIN_CEIL = 0.010;
var _AUD_FILL_CEIL = 0.005;

// Beyond this much backlog past the target, draining would take long enough that
// the latency is worse than the discontinuity. This is the only path that still
// discards a frame, and it exists so a pathological burst cannot park the buffer
// at a third of a second for the rest of the session.
var _AUD_DISCARD_GUARD_MS = 150;

// ─── A/V drift loop tuning ───────────────────────────────────────────────────
var _AUD_DRIFT_SAMPLE_FRAMES = 24;   // roughly one sample per 240 ms at 10 ms
var _AUD_DRIFT_FILTER_GAIN = 0.125;
var _AUD_DRIFT_DEADBAND_S = 0.005;   // ignore anything under 5 ms
var _AUD_DRIFT_GAIN = 0.08;
var _AUD_DRIFT_AUTHORITY = 0.0025;   // the A/V term may move rate by 0.25%
var _AUD_DRIFT_OUTLIER_S = 0.250;
var _AUD_DRIFT_OUTLIERS_FOR_EPOCH = 4;
var _AUD_DRIFT_COOLDOWN_SAMPLES = 12;

// A pipeline position report older than this is treated as absent, and the media
// element's own clock is used instead.
var _AUD_PIPELINE_STALE_MS = 1000;

// ─── Scheduler state ─────────────────────────────────────────────────────────
var _audNextTime = 0.0;              // context time the next frame starts at
var _audTargetMs = 50;
var _audGeneration = 0;
var _audVersionsPtr = 0;

var _audLoggedRateMismatch = false;
var _audLoggedSeqlockLoss = false;

// Content seconds handed to the context since the current epoch began. Paired
// with _audNextTime, this gives the media position currently being heard.
var _audContentScheduled = 0.0;
var _audEpochFrames = 0;             // frames since the last re-anchor

// Drift loop
var _audDriftEpochOffset = 0.0;
var _audDriftEpochInitialized = false;
var _audDriftFiltered = 0.0;
var _audDriftCorrection = 0.0;
var _audDriftCountdown = 0;
var _audDriftOutliers = 0;
var _audDriftCooldown = 0;

// Video clock, as published by the EMSS listener in wasm/wasmplayer.cpp
var _audPipelinePositionS = -1;
var _audPipelineAtMs = 0;

// Counters, readable from the console as window._mlAudioStats. Deliberately not
// added to the performance overlay: it is a video overlay, and plumbing these
// back into C++ would put main thread work on the audio path to report on the
// audio path.
var _audStats = null;

function _audResetStats() {
  _audStats = {
    framesScheduled: 0,
    framesDiscardedGuard: 0,
    framesDiscardedSeqlock: 0,
    framesDiscardedStale: 0,
    rateMin: 1.0,
    rateMax: 1.0,
    bufferMaxMs: 0,
    driftFilteredMs: 0,
    driftAbsMaxMs: 0,
    driftEpochs: 0,
    driftDiscontinuities: 0,
    pipelineClockUsed: false
  };
  window._mlAudioStats = _audStats;
}

// ─── Buffer pool ─────────────────────────────────────────────────────────────
//
// At a hundred frames a second, allocating a buffer per frame is a hundred
// objects a second for the collector to reclaim, on the same thread that has to
// stay free for video. A buffer whose samples are overwritten while a live
// source node is still reading it would glitch, so the ring is sized far deeper
// than the number of frames that can be scheduled ahead.
var _AUD_POOL_DEPTH = 32;
var _audPool = null;
var _audPoolIdx = 0;
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

// ─── Called from wasm/auddec.cpp ─────────────────────────────────────────────

// Once per stream, before any frame arrives.
function configureAudioScheduler(targetMs, versionsPtr, generation) {
  _audTargetMs = targetMs > 0 ? targetMs : 50;
  _audVersionsPtr = versionsPtr >>> 0;
  _audGeneration = generation >>> 0;
  _audReanchor();
  _audResetStats();
  console.log('%c[audio.js, configureAudioScheduler]', 'color: green;',
    'target ' + _audTargetMs + ' ms, generation ' + _audGeneration);
}

// The stream is going away. Anything still in flight is stale from here on.
function retireAudioGeneration(generation) {
  if ((generation >>> 0) === _audGeneration) {
    _audGeneration = 0;
  }
}

// Video clock update, in milliseconds on the pipeline's own timeline.
function publishPipelinePosition(positionMs) {
  _audPipelinePositionS = positionMs / 1000.0;
  _audPipelineAtMs = Date.now();
}

// ─── Internals ───────────────────────────────────────────────────────────────

function _audReanchor() {
  _audNextTime = 0.0;
  _audContentScheduled = 0.0;
  _audEpochFrames = 0;
  _audDriftEpochInitialized = false;
  _audDriftFiltered = 0.0;
  _audDriftCorrection = 0.0;
  _audDriftCountdown = 0;
  _audDriftOutliers = 0;
  _audDriftCooldown = 0;
}

// Where the video pipeline is now, in seconds on its own timeline, or null.
//
// The EMSS position is preferred: Samsung documents it as the intended source of
// time updates. The media element's clock is the fallback, because we have never
// confirmed on hardware that the EMSS callback fires at all, and a servo with no
// reference is worse than a servo with a coarser one.
function _audVideoPosition(ctx) {
  if (_audPipelinePositionS >= 0 &&
      (Date.now() - _audPipelineAtMs) < _AUD_PIPELINE_STALE_MS) {
    if (_audStats) { _audStats.pipelineClockUsed = true; }
    // Extrapolate to now at real time; playback rate is never altered on video
    return _audPipelinePositionS + (Date.now() - _audPipelineAtMs) / 1000.0;
  }

  var video = document.getElementById('wasm_module');
  if (video && isFinite(video.currentTime) && video.currentTime > 0.25) {
    if (_audStats) { _audStats.pipelineClockUsed = false; }
    return video.currentTime;
  }
  return null;
}

// How much audio content has actually been played since the epoch began.
//
// _audNextTime is where the next frame starts, so the difference from now is
// what is still queued. Converting queued wall time to content time would need
// the per-entry rate; every rate is within one percent of unity, so over a
// queue of at most a couple of hundred milliseconds the error is under two
// milliseconds, well inside the loop's deadband.
function _audPlayedContent(now) {
  var queued = _audNextTime - now;
  if (queued < 0) { queued = 0; }
  var played = _audContentScheduled - queued;
  return played > 0 ? played : 0;
}

function _audUpdateDrift(ctx, now) {
  // Nothing meaningful to measure until the epoch has some history and there is
  // actually a queue to reason about.
  if (_audEpochFrames < 8 || (_audNextTime - now) < 0.040) {
    _audDriftCorrection = 0.0;
    return;
  }
  if (_audDriftCooldown > 0) {
    _audDriftCooldown--;
    _audDriftCorrection = 0.0;
    return;
  }
  if (_audDriftCountdown > 0) {
    _audDriftCountdown--;
    return;
  }
  _audDriftCountdown = _AUD_DRIFT_SAMPLE_FRAMES;

  var videoS = _audVideoPosition(ctx);
  if (videoS === null) {
    _audDriftCorrection = 0.0;
    return;
  }

  var absoluteOffset = videoS - _audPlayedContent(now);
  if (!isFinite(absoluteOffset)) {
    if (_audStats) { _audStats.driftDiscontinuities++; }
    _audDriftCorrection = 0.0;
    return;
  }

  // The video clock and the AudioContext do not share an epoch, and there is no
  // reason they should: one counts from when the pipeline started, the other
  // from when the context was created. Comparing them in absolute terms would
  // read a perfectly healthy fixed offset as an enormous error. So calibrate
  // that offset once per epoch and control only what changes relative to it.
  if (!_audDriftEpochInitialized) {
    _audDriftEpochOffset = absoluteOffset;
    _audDriftEpochInitialized = true;
    _audDriftFiltered = 0.0;
    _audDriftCorrection = 0.0;
    if (_audStats) { _audStats.driftEpochs++; }
    return;
  }

  var raw = absoluteOffset - _audDriftEpochOffset;
  if (!isFinite(raw) || Math.abs(raw) > _AUD_DRIFT_OUTLIER_S) {
    // A single glitch in the video clock must not be allowed to reset the loop,
    // or a stream with an occasionally jumpy clock never accumulates any
    // history. A sustained jump is a genuinely new epoch.
    if (_audStats) { _audStats.driftDiscontinuities++; }
    _audDriftOutliers++;
    _audDriftCorrection = 0.0;
    if (_audDriftOutliers >= _AUD_DRIFT_OUTLIERS_FOR_EPOCH) {
      _audDriftEpochOffset = absoluteOffset;
      _audDriftOutliers = 0;
      _audDriftFiltered = 0.0;
      _audDriftCooldown = _AUD_DRIFT_COOLDOWN_SAMPLES;
      if (_audStats) { _audStats.driftEpochs++; }
    }
    return;
  }
  _audDriftOutliers = 0;

  _audDriftFiltered += _AUD_DRIFT_FILTER_GAIN * (raw - _audDriftFiltered);
  if (_audStats) {
    _audStats.driftFilteredMs = _audDriftFiltered * 1000;
    var absMs = Math.abs(_audDriftFiltered) * 1000;
    if (absMs > _audStats.driftAbsMaxMs) { _audStats.driftAbsMaxMs = absMs; }
  }

  // Positive drift means video is ahead, so audio has to be consumed faster to
  // catch up. Below the deadband, do nothing at all: chasing a couple of
  // milliseconds would keep the rate permanently off unity for no audible gain.
  var outside = Math.abs(_audDriftFiltered) > _AUD_DRIFT_DEADBAND_S
    ? _audDriftFiltered : 0.0;
  var correction = outside * _AUD_DRIFT_GAIN;
  if (correction > _AUD_DRIFT_AUTHORITY) { correction = _AUD_DRIFT_AUTHORITY; }
  if (correction < -_AUD_DRIFT_AUTHORITY) { correction = -_AUD_DRIFT_AUTHORITY; }
  _audDriftCorrection = correction;
}

// The rate this frame is played at, combining buffer depth and A/V drift.
function _audPlaybackRate(now, entryDuration) {
  var queued = _audNextTime - now;
  if (queued < 0) { queued = 0; }
  var totalS = queued + entryDuration;
  var targetS = _audTargetMs / 1000.0;

  if (_audStats) {
    var ms = totalS * 1000;
    if (ms > _audStats.bufferMaxMs) { _audStats.bufferMaxMs = ms; }
  }

  var correction;
  if (totalS > targetS) {
    // Too deep: consume faster than it arrives and the backlog clears itself.
    correction = Math.min(_AUD_DRAIN_CEIL, (totalS - targetS) * _AUD_DRAIN_GAIN);
  } else if (totalS < targetS / 2) {
    // Getting thin: stretching slightly buys time for the next frame to land,
    // which is the only useful thing to do about an impending gap.
    correction = -Math.min(_AUD_FILL_CEIL, (targetS / 2 - totalS) * _AUD_DRAIN_GAIN);
  } else {
    correction = 0.0;
  }

  var rate = 1.0 + correction + _audDriftCorrection;
  if (rate > _AUD_RATE_MAX) { rate = _AUD_RATE_MAX; }
  if (rate < _AUD_RATE_MIN) { rate = _AUD_RATE_MIN; }

  if (_audStats) {
    if (rate < _audStats.rateMin) { _audStats.rateMin = rate; }
    if (rate > _audStats.rateMax) { _audStats.rateMax = rate; }
  }
  return rate;
}

// ─── The frame path ──────────────────────────────────────────────────────────

// Called by the C++ feeder thread for each decoded frame.
//   ptr        - byte offset of interleaved int16 PCM in the WASM heap
//   spf        - samples per frame, per channel
//   channels   - channel count
//   sampleRate - Hz, as negotiated with the host
//   slot       - index of the PCM slot, for the seqlock re-read
//   version    - the slot's version when the feeder finished writing it
//   generation - the stream this frame belongs to
function _audReceiveFrame(ptr, spf, channels, sampleRate, slot, version, generation) {
  // A frame published by a stream that has already been torn down must never be
  // scheduled against the current stream's clock.
  if ((generation >>> 0) !== _audGeneration || _audGeneration === 0) {
    if (_audStats) { _audStats.framesDiscardedStale++; }
    return;
  }

  var ctx = window._mlAudioCtx;
  if (!ctx) {
    return;
  }

  if (ctx.state === 'suspended') {
    try { ctx.resume(); } catch (e) {}
    // Drop this frame; the epoch realigns on the next one after resuming
    _audReanchor();
    return;
  }

  var now = ctx.currentTime;

  // Behind the clock, at startup or after a gap: start a new epoch. The drift
  // loop's calibration is only valid within one continuous run of scheduling.
  if (_audNextTime < now) {
    _audNextTime = now;
    _audContentScheduled = 0.0;
    _audEpochFrames = 0;
    _audDriftEpochInitialized = false;
    _audDriftFiltered = 0.0;
    _audDriftCorrection = 0.0;
  }

  // The servo handles ordinary backlog by consuming faster. Only a burst large
  // enough that draining it would hold the latency high for many seconds is
  // still worth discarding.
  if ((_audNextTime - now) * 1000 > _audTargetMs + _AUD_DISCARD_GUARD_MS) {
    if (_audStats) { _audStats.framesDiscardedGuard++; }
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

  // Close the seqlock. If the feeder came back round to this slot while the copy
  // above was running, the samples are a splice of two different moments and
  // playing them would be an audible click for no reason: the frame is already
  // late enough to be expendable.
  if (_audVersionsPtr !== 0) {
    var current = Module.HEAPU32[(_audVersionsPtr >> 2) + slot];
    if (current !== (version >>> 0)) {
      if (_audStats) { _audStats.framesDiscardedSeqlock++; }
      if (!_audLoggedSeqlockLoss) {
        _audLoggedSeqlockLoss = true;
        console.warn('%c[audio.js, _audReceiveFrame]', 'color: gray;',
          'A PCM slot was overwritten before it could be copied; the main thread ' +
          'is stalling long enough to lap the frame pool.');
      }
      return;
    }
  }

  _audPoolIdx = (_audPoolIdx + 1) % _AUD_POOL_DEPTH;

  _audUpdateDrift(ctx, now);

  // A source node cannot be reused: the specification allows start() once per
  // node, so this allocation is unavoidable. Only the buffer is pooled.
  var srcNode = ctx.createBufferSource();
  srcNode.buffer = abuf;

  var rate = _audPlaybackRate(now, abuf.duration);
  srcNode.playbackRate.value = rate;
  srcNode.connect(ctx.destination);
  srcNode.start(_audNextTime);

  // Wall time advances by the content divided by the rate; content advances by
  // the full frame. Keeping both is what lets _audPlayedContent() convert
  // between the two timelines.
  _audNextTime += abuf.duration / rate;
  _audContentScheduled += abuf.duration;
  _audEpochFrames++;
  if (_audStats) { _audStats.framesScheduled++; }
}

function startAudioScheduler() {
  _audReanchor();
  _audLoggedRateMismatch = false;
  _audLoggedSeqlockLoss = false;
  _audPipelinePositionS = -1;
  _audPipelineAtMs = 0;
  // The pool is tied to an AudioContext, which is recreated per stream
  _audPool = null;
  _audPoolChannels = _audPoolFrames = _audPoolRate = 0;
  if (_audStats === null) { _audResetStats(); }
}

function stopAudioScheduler() {
  _audReanchor();
  _audGeneration = 0;
  _audVersionsPtr = 0;
  _audPipelinePositionS = -1;
  _audPool = null;
  _audPoolChannels = _audPoolFrames = _audPoolRate = 0;
}
