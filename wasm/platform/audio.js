// Low-latency Web Audio renderer.
//
// Opus is decoded by the C++ feeder into a lock-free PCM ring in the shared
// WASM heap. An AudioWorklet pulls that ring on the browser's audio rendering
// thread, so decoded frames never become main-thread tasks and no
// AudioBufferSourceNode is allocated per packet. Older Tizen engines fall back
// to ScriptProcessor pulling the same ring in 1024-frame blocks.

// Indexes into AudioRingControl in wasm/audio_ring.hpp.
var _AUD_CTL_READ = 0;
var _AUD_CTL_WRITE = 1;
var _AUD_CTL_GENERATION = 2;
var _AUD_CTL_MODE = 3;
var _AUD_CTL_UNDERRUNS = 4;
var _AUD_CTL_OVERRUNS = 5;
var _AUD_CTL_TARGET = 6;
var _AUD_CTL_MIN_DEPTH = 7;
var _AUD_CTL_MAX_DEPTH = 8;
var _AUD_CTL_CONSUMED = 9;
var _AUD_CTL_DRIFT_PPM = 10;
var _AUD_CTL_STARTED = 11;
var _AUD_CTL_EPOCH = 12;
var _AUD_CTL_INITIAL_TARGET = 13;
var _AUD_CTL_MAX_TARGET = 14;

var _AUD_MODE_WAITING = 0;
var _AUD_MODE_WORKLET = 1;
var _AUD_MODE_FALLBACK = 2;
var _AUD_MODE_STOPPED = 3;

var _AUD_DRIFT_FILTER_GAIN = 0.125;
var _AUD_DRIFT_DEADBAND_S = 0.005;
var _AUD_DRIFT_GAIN = 0.08;
var _AUD_DRIFT_MAX_PPM = 2500;
var _AUD_DRIFT_OUTLIER_S = 0.250;
var _AUD_DRIFT_OUTLIERS_FOR_EPOCH = 4;

var _audGeneration = 0;
var _audRequestedTargetMs = 50;
var _audControlPtr = 0;
var _audPcmPtr = 0;
var _audCapacityFrames = 0;
var _audChannels = 0;
var _audSourceRate = 48000;
var _audControl = null;
var _audPcm = null;

var _audWorkletNode = null;
var _audScriptNode = null;
var _audPreparePromise = null;
var _audPrepareContext = null;
var _audConfigToken = 0;

var _audFallbackReadFrame = 0;
var _audFallbackPhase = 0.0;
var _audFallbackEpoch = 0;
var _audFallbackStarted = false;
var _audFallbackStableFrames = 0;
var _audFallbackStatsCountdown = 0;
var _audFallbackOutputData = [];

var _audPipelinePositionS = -1;
var _audPipelineAtMs = 0;
var _audDriftEpochOffset = 0.0;
var _audDriftEpochInitialized = false;
var _audDriftFiltered = 0.0;
var _audDriftOutliers = 0;
var _audLastUnderruns = 0;

var _audStats = null;

function _audNowMs() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
}

function _audClamp(value, minimum, maximum) {
  return value < minimum ? minimum : (value > maximum ? maximum : value);
}

function _audResetDrift() {
  _audDriftEpochOffset = 0.0;
  _audDriftEpochInitialized = false;
  _audDriftFiltered = 0.0;
  _audDriftOutliers = 0;
  _audLastUnderruns = 0;
  if (_audControl) {
    Atomics.store(_audControl, _AUD_CTL_DRIFT_PPM, 0);
  }
}

function _audResetStats() {
  _audStats = {
    backend: 'waiting',
    requestedTargetMs: _audRequestedTargetMs,
    targetMs: 0,
    depthMs: 0,
    minDepthMs: 0,
    maxDepthMs: 0,
    underruns: 0,
    overruns: 0,
    driftMs: 0,
    driftPpm: 0,
    started: false
  };
  window._mlAudioStats = _audStats;
}

function _audRefreshStats() {
  if (!_audStats || !_audControl || _audSourceRate <= 0) {
    return;
  }
  var read = Atomics.load(_audControl, _AUD_CTL_READ) >>> 0;
  var write = Atomics.load(_audControl, _AUD_CTL_WRITE) >>> 0;
  var minimum = Atomics.load(_audControl, _AUD_CTL_MIN_DEPTH) >>> 0;
  var maximum = Atomics.load(_audControl, _AUD_CTL_MAX_DEPTH) >>> 0;
  var mode = Atomics.load(_audControl, _AUD_CTL_MODE) | 0;
  _audStats.backend = mode === _AUD_MODE_WORKLET ? 'AudioWorklet' :
    (mode === _AUD_MODE_FALLBACK ? 'ScriptProcessor' : 'waiting');
  _audStats.targetMs =
    (Atomics.load(_audControl, _AUD_CTL_TARGET) >>> 0) * 1000 / _audSourceRate;
  _audStats.depthMs = ((write - read) >>> 0) * 1000 / _audSourceRate;
  _audStats.minDepthMs = minimum === 0xffffffff ? 0 : minimum * 1000 / _audSourceRate;
  _audStats.maxDepthMs = maximum * 1000 / _audSourceRate;
  _audStats.underruns = Atomics.load(_audControl, _AUD_CTL_UNDERRUNS) >>> 0;
  _audStats.overruns = Atomics.load(_audControl, _AUD_CTL_OVERRUNS) >>> 0;
  _audStats.driftMs = _audDriftFiltered * 1000;
  _audStats.driftPpm = Atomics.load(_audControl, _AUD_CTL_DRIFT_PPM) | 0;
  _audStats.started = (Atomics.load(_audControl, _AUD_CTL_STARTED) | 0) !== 0;
}

function _audClaimPromise(promise) {
  if (promise && typeof promise.then === 'function') {
    promise.then(function() {}, function() {});
  }
}

function _audResumeContext(ctx) {
  if (!ctx || ctx.state !== 'suspended') {
    return;
  }
  try {
    _audClaimPromise(ctx.resume());
  } catch (e) {}
}

function _audPrepareBackend(ctx) {
  if (!ctx) {
    return Promise.resolve(false);
  }
  if (_audPreparePromise && _audPrepareContext === ctx) {
    return _audPreparePromise;
  }

  _audPrepareContext = ctx;
  if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function' &&
      typeof AudioWorkletNode !== 'undefined') {
    try {
      _audPreparePromise = ctx.audioWorklet
        .addModule('platform/audio-worklet.js')
        .then(function() { return true; }, function() { return false; });
    } catch (e) {
      _audPreparePromise = Promise.resolve(false);
    }
  } else {
    _audPreparePromise = Promise.resolve(false);
  }
  return _audPreparePromise;
}

function _audDisconnectBackend(markStopped) {
  if (_audControl && markStopped) {
    Atomics.store(_audControl, _AUD_CTL_MODE, _AUD_MODE_STOPPED);
  }

  if (_audWorkletNode) {
    try { _audWorkletNode.port.postMessage({ type: 'stop' }); } catch (e) {}
    try { _audWorkletNode.disconnect(); } catch (e) {}
    try { _audWorkletNode.port.close(); } catch (e) {}
    _audWorkletNode = null;
  }
  if (_audScriptNode) {
    _audScriptNode.onaudioprocess = null;
    try { _audScriptNode.disconnect(); } catch (e) {}
    _audScriptNode = null;
  }
}

function _audConfigureDestination(ctx, channels) {
  try {
    if (ctx.destination && ctx.destination.maxChannelCount) {
      ctx.destination.channelCount = Math.min(
        channels, ctx.destination.maxChannelCount);
      ctx.destination.channelCountMode = 'explicit';
      ctx.destination.channelInterpretation = 'speakers';
    }
  } catch (e) {
    // Some TV engines expose these properties as read-only. The node still
    // downmixes through the browser's default speaker layout in that case.
  }
}

function _audActivateWorklet(ctx, token) {
  if (token !== _audConfigToken || !_audControl || _audGeneration === 0) {
    return false;
  }
  try {
    _audConfigureDestination(ctx, _audChannels);
    var node = new AudioWorkletNode(ctx, 'moonlight-pcm', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [_audChannels],
      channelCount: _audChannels,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    });
    node.channelCount = _audChannels;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'speakers';

    var failed = false;
    var failToFallback = function() {
      if (failed || token !== _audConfigToken) { return; }
      failed = true;
      try { node.disconnect(); } catch (e) {}
      if (_audWorkletNode === node) { _audWorkletNode = null; }
      if (_audControl) {
        Atomics.store(_audControl, _AUD_CTL_MODE, _AUD_MODE_WAITING);
      }
      _audActivateFallback(ctx, token);
    };
    node.onprocessorerror = failToFallback;
    node.port.onmessage = function(event) {
      if (event.data && event.data.type === 'error') {
        failToFallback();
      }
    };

    node.port.postMessage({
      type: 'init',
      memory: Module.HEAP16.buffer,
      controlPtr: _audControlPtr,
      pcmPtr: _audPcmPtr,
      capacityFrames: _audCapacityFrames,
      channels: _audChannels,
      sourceRate: _audSourceRate,
      generation: _audGeneration
    });
    node.connect(ctx.destination);
    _audWorkletNode = node;
    Atomics.store(_audControl, _AUD_CTL_MODE, _AUD_MODE_WORKLET);
    _audStats.backend = 'AudioWorklet';
    _audResumeContext(ctx);
    return true;
  } catch (e) {
    return false;
  }
}

function _audClearOutput(outputBuffer, from) {
  for (var channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
    outputBuffer.getChannelData(channel).fill(0, from || 0);
  }
}

function _audNoteFallbackDepth(depth) {
  if (--_audFallbackStatsCountdown > 0) {
    return;
  }
  _audFallbackStatsCountdown = 4;
  var oldMin = Atomics.load(_audControl, _AUD_CTL_MIN_DEPTH) >>> 0;
  while (depth < oldMin) {
    var observedMin = Atomics.compareExchange(
      _audControl, _AUD_CTL_MIN_DEPTH, oldMin | 0, depth | 0) >>> 0;
    if (observedMin === oldMin) { break; }
    oldMin = observedMin;
  }
  var oldMax = Atomics.load(_audControl, _AUD_CTL_MAX_DEPTH) >>> 0;
  while (depth > oldMax) {
    var observedMax = Atomics.compareExchange(
      _audControl, _AUD_CTL_MAX_DEPTH, oldMax | 0, depth | 0) >>> 0;
    if (observedMax === oldMax) { break; }
    oldMax = observedMax;
  }
}

function _audFallbackUnderrun(outputBuffer, from) {
  _audClearOutput(outputBuffer, from);
  if (_audFallbackStarted) {
    Atomics.add(_audControl, _AUD_CTL_UNDERRUNS, 1);
    var target = Atomics.load(_audControl, _AUD_CTL_TARGET) >>> 0;
    var maximum = Atomics.load(_audControl, _AUD_CTL_MAX_TARGET) >>> 0;
    var step = Math.max(1, Math.round(_audSourceRate * 0.005));
    Atomics.store(_audControl, _AUD_CTL_TARGET,
      Math.min(maximum, target + step) | 0);
  }
  _audFallbackStarted = false;
  _audFallbackStableFrames = 0;
  Atomics.store(_audControl, _AUD_CTL_STARTED, 0);
}

function _audProcessFallback(event) {
  var output = event.outputBuffer;
  if (!_audControl || !_audPcm || _audGeneration === 0 ||
      (Atomics.load(_audControl, _AUD_CTL_MODE) | 0) !== _AUD_MODE_FALLBACK ||
      (Atomics.load(_audControl, _AUD_CTL_GENERATION) >>> 0) !== _audGeneration) {
    _audClearOutput(output, 0);
    return;
  }

  var epoch = Atomics.load(_audControl, _AUD_CTL_EPOCH) >>> 0;
  if (epoch !== _audFallbackEpoch) {
    _audFallbackEpoch = epoch;
    _audFallbackReadFrame = Atomics.load(_audControl, _AUD_CTL_READ) >>> 0;
    _audFallbackPhase = 0.0;
    _audFallbackStarted = false;
    _audFallbackStableFrames = 0;
    Atomics.store(_audControl, _AUD_CTL_STARTED, 0);
  }

  var writeFrame = Atomics.load(_audControl, _AUD_CTL_WRITE) >>> 0;
  var depth = (writeFrame - _audFallbackReadFrame) >>> 0;
  var target = Atomics.load(_audControl, _AUD_CTL_TARGET) >>> 0;
  _audNoteFallbackDepth(depth);
  if (!_audFallbackStarted) {
    if (depth < target + 2) {
      _audClearOutput(output, 0);
      return;
    }
    _audFallbackStarted = true;
    Atomics.store(_audControl, _AUD_CTL_STARTED, 1);
  }

  var outputFrames = output.length;
  var outputRate = output.sampleRate ||
    (window._mlAudioCtx ? window._mlAudioCtx.sampleRate : _audSourceRate);
  var driftPpm = Atomics.load(_audControl, _AUD_CTL_DRIFT_PPM) | 0;
  var error = target > 0 ? (depth - target) / target : 0;
  var bufferPpm = _audClamp(Math.round(error * 10000), -3000, 7500);
  var totalPpm = _audClamp(bufferPpm + driftPpm, -5000, 10000);
  var ratio = (_audSourceRate / outputRate) * (1 + totalPpm / 1000000);
  var consumed = 0;
  var mask = _audCapacityFrames - 1;
  var outputChannels = output.numberOfChannels;
  if (_audFallbackOutputData.length !== outputChannels) {
    _audFallbackOutputData = new Array(outputChannels);
  }
  var outputData = _audFallbackOutputData;
  for (var outputChannel = 0; outputChannel < outputChannels; outputChannel++) {
    outputData[outputChannel] = output.getChannelData(outputChannel);
  }

  for (var frame = 0; frame < outputFrames; frame++) {
    var available = (writeFrame - _audFallbackReadFrame) >>> 0;
    if (available < 2) {
      Atomics.store(_audControl, _AUD_CTL_READ, _audFallbackReadFrame | 0);
      Atomics.add(_audControl, _AUD_CTL_CONSUMED, consumed | 0);
      _audFallbackUnderrun(output, frame);
      return;
    }

    var first = _audFallbackReadFrame & mask;
    var second = (_audFallbackReadFrame + 1) & mask;
    var fraction = _audFallbackPhase;
    var copyChannels = Math.min(outputChannels, _audChannels);
    for (var channel = 0; channel < copyChannels; channel++) {
      var a = _audPcm[first * _audChannels + channel];
      var b = _audPcm[second * _audChannels + channel];
      outputData[channel][frame] = (a + (b - a) * fraction) / 32768.0;
    }
    for (var extra = copyChannels; extra < outputChannels; extra++) {
      outputData[extra][frame] = 0;
    }

    _audFallbackPhase += ratio;
    var advance = Math.floor(_audFallbackPhase);
    if (advance > 0) {
      _audFallbackPhase -= advance;
      _audFallbackReadFrame = (_audFallbackReadFrame + advance) >>> 0;
      consumed += advance;
    }
  }

  Atomics.store(_audControl, _AUD_CTL_READ, _audFallbackReadFrame | 0);
  Atomics.add(_audControl, _AUD_CTL_CONSUMED, consumed | 0);
  _audFallbackStableFrames += outputFrames;
  if (_audFallbackStableFrames >= outputRate * 60) {
    _audFallbackStableFrames = 0;
    var currentTarget = Atomics.load(_audControl, _AUD_CTL_TARGET) >>> 0;
    var initialTarget = Atomics.load(_audControl, _AUD_CTL_INITIAL_TARGET) >>> 0;
    if (currentTarget > initialTarget) {
      var reduce = Math.max(1, Math.round(_audSourceRate * 0.0025));
      Atomics.store(_audControl, _AUD_CTL_TARGET,
        Math.max(initialTarget, currentTarget - reduce) | 0);
    }
  }
}

function _audActivateFallback(ctx, token) {
  if (token !== _audConfigToken || !_audControl || _audGeneration === 0) {
    return false;
  }
  try {
    _audConfigureDestination(ctx, _audChannels);
    var create = ctx.createScriptProcessor || ctx.createJavaScriptNode;
    if (!create) {
      Atomics.store(_audControl, _AUD_CTL_MODE, _AUD_MODE_STOPPED);
      _audStats.backend = 'unavailable';
      return false;
    }
    var node = create.call(ctx, 1024, 0, _audChannels);
    node.channelCount = _audChannels;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'speakers';
    _audFallbackReadFrame = Atomics.load(_audControl, _AUD_CTL_READ) >>> 0;
    _audFallbackEpoch = Atomics.load(_audControl, _AUD_CTL_EPOCH) >>> 0;
    _audFallbackPhase = 0.0;
    _audFallbackStarted = false;
    _audFallbackStableFrames = 0;
    node.onaudioprocess = _audProcessFallback;
    node.connect(ctx.destination);
    _audScriptNode = node;
    Atomics.store(_audControl, _AUD_CTL_MODE, _AUD_MODE_FALLBACK);
    _audStats.backend = 'ScriptProcessor';
    _audResumeContext(ctx);
    return true;
  } catch (e) {
    Atomics.store(_audControl, _AUD_CTL_MODE, _AUD_MODE_STOPPED);
    _audStats.backend = 'unavailable';
    return false;
  }
}

// Called once per negotiated stream by wasm/auddec.cpp.
function configureAudioScheduler(targetMs, controlPtr, pcmPtr, capacityFrames,
                                 channels, sourceRate, generation) {
  _audDisconnectBackend(false);
  _audRequestedTargetMs = targetMs > 0 ? targetMs : 50;
  _audControlPtr = controlPtr >>> 0;
  _audPcmPtr = pcmPtr >>> 0;
  _audCapacityFrames = capacityFrames >>> 0;
  _audChannels = channels >>> 0;
  _audSourceRate = sourceRate >>> 0;
  _audGeneration = generation >>> 0;
  _audConfigToken++;
  var token = _audConfigToken;

  try {
    _audControl = new Int32Array(Module.HEAP32.buffer, _audControlPtr, 16);
    _audPcm = new Int16Array(
      Module.HEAP16.buffer, _audPcmPtr, _audCapacityFrames * _audChannels);
  } catch (e) {
    _audControl = null;
    _audPcm = null;
    return;
  }

  Atomics.store(_audControl, _AUD_CTL_MODE, _AUD_MODE_WAITING);
  _audPipelinePositionS = -1;
  _audPipelineAtMs = 0;
  _audResetDrift();
  _audResetStats();

  var ctx = window._mlAudioCtx;
  if (!ctx) {
    Atomics.store(_audControl, _AUD_CTL_MODE, _AUD_MODE_STOPPED);
    _audStats.backend = 'no AudioContext';
    return;
  }

  _audPrepareBackend(ctx).then(function(workletAvailable) {
    if (token !== _audConfigToken || ctx !== window._mlAudioCtx) {
      return;
    }
    if (!workletAvailable || !_audActivateWorklet(ctx, token)) {
      _audActivateFallback(ctx, token);
    }
  });
}

function retireAudioGeneration(generation) {
  if ((generation >>> 0) !== _audGeneration) {
    return;
  }
  if (_audControl) {
    Atomics.store(_audControl, _AUD_CTL_MODE, _AUD_MODE_STOPPED);
    Atomics.store(_audControl, _AUD_CTL_DRIFT_PPM, 0);
  }
  _audGeneration = 0;
  _audConfigToken++;
  _audDisconnectBackend(false);
}

// Video position is reported by the Samsung elementary media source. The fixed
// offset between its epoch and the audio content counter is calibrated once;
// only changes in that offset are servoed.
function publishPipelinePosition(positionMs) {
  _audPipelinePositionS = positionMs / 1000.0;
  _audPipelineAtMs = _audNowMs();
  if (!_audControl || _audGeneration === 0 || _audSourceRate <= 0) {
    return;
  }

  _audRefreshStats();
  var underruns = Atomics.load(_audControl, _AUD_CTL_UNDERRUNS) >>> 0;
  if (underruns !== _audLastUnderruns) {
    _audLastUnderruns = underruns;
    _audDriftEpochInitialized = false;
    _audDriftFiltered = 0.0;
    Atomics.store(_audControl, _AUD_CTL_DRIFT_PPM, 0);
  }

  var consumed = Atomics.load(_audControl, _AUD_CTL_CONSUMED) >>> 0;
  if (consumed < _audSourceRate / 4 ||
      (Atomics.load(_audControl, _AUD_CTL_STARTED) | 0) === 0) {
    return;
  }

  var audioContentS = consumed / _audSourceRate;
  var absoluteOffset = _audPipelinePositionS - audioContentS;
  if (!isFinite(absoluteOffset)) {
    return;
  }
  if (!_audDriftEpochInitialized) {
    _audDriftEpochOffset = absoluteOffset;
    _audDriftEpochInitialized = true;
    _audDriftFiltered = 0.0;
    _audDriftOutliers = 0;
    Atomics.store(_audControl, _AUD_CTL_DRIFT_PPM, 0);
    return;
  }

  var raw = absoluteOffset - _audDriftEpochOffset;
  if (!isFinite(raw) || Math.abs(raw) > _AUD_DRIFT_OUTLIER_S) {
    _audDriftOutliers++;
    Atomics.store(_audControl, _AUD_CTL_DRIFT_PPM, 0);
    if (_audDriftOutliers >= _AUD_DRIFT_OUTLIERS_FOR_EPOCH) {
      _audDriftEpochOffset = absoluteOffset;
      _audDriftFiltered = 0.0;
      _audDriftOutliers = 0;
    }
    return;
  }
  _audDriftOutliers = 0;
  _audDriftFiltered +=
    _AUD_DRIFT_FILTER_GAIN * (raw - _audDriftFiltered);
  var correction = Math.abs(_audDriftFiltered) > _AUD_DRIFT_DEADBAND_S
    ? _audDriftFiltered * _AUD_DRIFT_GAIN * 1000000 : 0;
  var ppm = Math.round(_audClamp(
    correction, -_AUD_DRIFT_MAX_PPM, _AUD_DRIFT_MAX_PPM));
  Atomics.store(_audControl, _AUD_CTL_DRIFT_PPM, ppm);
  _audRefreshStats();
}

// Called synchronously from the user gesture that starts a game. Loading the
// worklet module here gives it the host launch/pairing interval to complete
// before the first Opus frame arrives.
function startAudioScheduler() {
  _audDisconnectBackend(true);
  _audGeneration = 0;
  _audControl = null;
  _audPcm = null;
  _audControlPtr = _audPcmPtr = 0;
  _audPipelinePositionS = -1;
  _audPipelineAtMs = 0;
  _audResetDrift();
  if (_audStats === null) { _audResetStats(); }
  var ctx = window._mlAudioCtx;
  if (ctx) {
    _audResumeContext(ctx);
    _audPrepareBackend(ctx);
  }
}

function stopAudioScheduler(closeContext) {
  _audConfigToken++;
  _audDisconnectBackend(true);
  _audGeneration = 0;
  _audControl = null;
  _audPcm = null;
  _audControlPtr = _audPcmPtr = 0;
  _audPipelinePositionS = -1;
  _audPipelineAtMs = 0;
  _audResetDrift();
  if (closeContext && window._mlAudioCtx) {
    var closing = window._mlAudioCtx;
    window._mlAudioCtx = null;
    try { _audClaimPromise(closing.close()); } catch (e) {}
    if (_audPrepareContext === closing) {
      _audPrepareContext = null;
      _audPreparePromise = null;
    }
  }
}
