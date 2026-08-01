// Measures the cadence at which this browser actually presents animation
// frames. The result is sent to Sunshine as clientRefreshRateX100, allowing the
// encoder cadence to follow the TV rather than assuming that the selected
// stream FPS is also the panel refresh rate.
//
// This is capability-based and deliberately model-agnostic. It runs only in
// menus, rejects suspended/background samples, and stops once enough stable
// data has been collected so it cannot compete with streaming.
var _displayRefreshX100 = 0;
var _displayRefreshRawHz = 0;
var _displayRefreshDeviationMs = 0;
var _displayRefreshSamples = [];
var _displayRefreshRaf = 0;
var _displayRefreshLast = 0;
var _displayRefreshDeadline = 0;

// Stream/display telemetry. Presentation callbacks are enabled only while the
// performance overlay is visible, so normal gameplay pays no per-frame JS cost.
var _displayStreamFps = 0;
var _displayHostRefreshX100 = 0;
var _presentationVideo = null;
var _presentationRequest = 0;
var _presentationSupported = null;
var _presentationGeneration = 0;
var _presentationLastTime = 0;
var _presentationLastFrame = 0;
var _presentationFrameGaps = 0;
var _presentationIntervals = new Array(120);
var _presentationIntervalCount = 0;
var _presentationIntervalIndex = 0;

function _displaySnapRefresh(hz) {
  var commonRates = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120];
  var best = hz;
  var bestDistance = 0.45;
  for (var i = 0; i < commonRates.length; i++) {
    var distance = Math.abs(hz - commonRates[i]);
    if (distance < bestDistance) {
      best = commonRates[i];
      bestDistance = distance;
    }
  }
  return best;
}

function _displayFinishRefreshEstimate() {
  if (_displayRefreshRaf) {
    window.cancelAnimationFrame(_displayRefreshRaf);
    _displayRefreshRaf = 0;
  }
  if (_displayRefreshSamples.length < 30) {
    return;
  }

  var samples = _displayRefreshSamples.slice().sort(function(a, b) { return a - b; });
  var trim = Math.floor(samples.length * 0.1);
  var sum = 0;
  var sumSq = 0;
  var count = 0;
  for (var i = trim; i < samples.length - trim; i++) {
    sum += samples[i];
    sumSq += samples[i] * samples[i];
    count++;
  }
  if (count > 0 && sum > 0) {
    var meanMs = sum / count;
    var variance = (sumSq / count) - (meanMs * meanMs);
    _displayRefreshRawHz = 1000 / meanMs;
    _displayRefreshDeviationMs = Math.sqrt(Math.max(0, variance));
    var hz = _displaySnapRefresh(_displayRefreshRawHz);
    _displayRefreshX100 = Math.round(hz * 100);
    window._mlDisplayRefreshX100 = _displayRefreshX100;
    window._mlDisplayRefreshRawHz = _displayRefreshRawHz;
    console.log('%c[display.js]', 'color: green;',
      'Measured display cadence: ' + _displayRefreshRawHz.toFixed(3) + ' Hz; reporting ' +
      (_displayRefreshX100 / 100).toFixed(2) + ' Hz');
  }
}

function startDisplayRefreshEstimator() {
  if (_displayRefreshRaf || typeof window.requestAnimationFrame !== 'function') {
    return;
  }
  _displayRefreshSamples.length = 0;
  _displayRefreshLast = 0;
  _displayRefreshDeadline = Date.now() + 8000;

  var sample = function(timestamp) {
    if (_displayRefreshLast) {
      var delta = timestamp - _displayRefreshLast;
      // Valid for panels from 24 through 120 Hz. Longer intervals mean the
      // page was interrupted; shorter ones are duplicate/invalid timestamps.
      if (delta >= 7.5 && delta <= 43) {
        _displayRefreshSamples.push(delta);
      }
    }
    _displayRefreshLast = timestamp;
    if (_displayRefreshSamples.length >= 240 || Date.now() >= _displayRefreshDeadline) {
      _displayFinishRefreshEstimate();
      return;
    }
    _displayRefreshRaf = window.requestAnimationFrame(sample);
  };
  _displayRefreshRaf = window.requestAnimationFrame(sample);
}

function stopDisplayRefreshEstimator() {
  _displayFinishRefreshEstimate();
}

function getDisplayRefreshRateX100(streamFps) {
  if (_displayRefreshX100 === 0 && _displayRefreshSamples.length >= 30) {
    _displayFinishRefreshEstimate();
  }
  if (_displayRefreshX100 >= 2000 && _displayRefreshX100 <= 24000) {
    return _displayRefreshX100;
  }
  var fallback = parseInt(streamFps, 10);
  return isFinite(fallback) && fallback > 0 ? fallback * 100 : 6000;
}

function setDisplayStreamReference(streamFps, hostRefreshX100) {
  _displayStreamFps = parseFloat(streamFps) || 0;
  _displayHostRefreshX100 = parseInt(hostRefreshX100, 10) || 0;
}

function _resetPresentationStats() {
  _presentationLastTime = 0;
  _presentationLastFrame = 0;
  _presentationFrameGaps = 0;
  _presentationIntervalCount = 0;
  _presentationIntervalIndex = 0;
}

function _recordPresentationInterval(intervalMs) {
  if (intervalMs < 7.5 || intervalMs > 43) {
    return;
  }
  _presentationIntervals[_presentationIntervalIndex] = intervalMs;
  _presentationIntervalIndex =
    (_presentationIntervalIndex + 1) % _presentationIntervals.length;
  if (_presentationIntervalCount < _presentationIntervals.length) {
    _presentationIntervalCount++;
  }
}

function startVideoPresentationObserver(videoElement) {
  stopVideoPresentationObserver();
  _resetPresentationStats();
  _presentationVideo = videoElement || null;
  _presentationSupported = !!(
    _presentationVideo &&
    typeof _presentationVideo.requestVideoFrameCallback === 'function'
  );
  if (!_presentationSupported) {
    return;
  }

  var generation = _presentationGeneration;
  var observe = function(now, metadata) {
    if (!_presentationVideo || generation !== _presentationGeneration) {
      return;
    }
    metadata = metadata || {};
    var presentationTime = Number(metadata.expectedDisplayTime);
    if (!isFinite(presentationTime)) {
      presentationTime = Number(metadata.presentationTime);
    }
    if (!isFinite(presentationTime)) {
      presentationTime = Number(now);
    }
    if (_presentationLastTime > 0 && presentationTime > _presentationLastTime) {
      _recordPresentationInterval(presentationTime - _presentationLastTime);
    }
    _presentationLastTime = presentationTime;

    var presentedFrames = Number(metadata.presentedFrames);
    if (isFinite(presentedFrames) && presentedFrames > 0) {
      if (_presentationLastFrame > 0 && presentedFrames > _presentationLastFrame + 1) {
        _presentationFrameGaps += presentedFrames - _presentationLastFrame - 1;
      }
      _presentationLastFrame = presentedFrames;
    }
    try {
      _presentationRequest = _presentationVideo.requestVideoFrameCallback(observe);
    } catch (error) {
      _presentationSupported = false;
      _presentationRequest = 0;
      _presentationVideo = null;
    }
  };
  try {
    _presentationRequest = _presentationVideo.requestVideoFrameCallback(observe);
  } catch (error) {
    _presentationSupported = false;
    _presentationRequest = 0;
    _presentationVideo = null;
  }
}

function stopVideoPresentationObserver() {
  _presentationGeneration++;
  if (_presentationVideo && _presentationRequest &&
      typeof _presentationVideo.cancelVideoFrameCallback === 'function') {
    try {
      _presentationVideo.cancelVideoFrameCallback(_presentationRequest);
    } catch (error) {
      // The generation guard above still prevents a stale callback rescheduling.
    }
  }
  _presentationRequest = 0;
  _presentationVideo = null;
}

function getDisplayTelemetryLines() {
  var rawHz = _displayRefreshRawHz > 0
    ? _displayRefreshRawHz.toFixed(3) : 'unknown';
  var reportedHz = _displayHostRefreshX100 > 0
    ? (_displayHostRefreshX100 / 100).toFixed(2) : 'unknown';
  var streamFps = _displayStreamFps > 0
    ? _displayStreamFps.toFixed(2) : 'unknown';
  var measurementDeviation = _displayRefreshRawHz > 0
    ? _displayRefreshDeviationMs.toFixed(2) : 'unknown';
  var panelLine = 'Panel refresh: ' + rawHz + ' Hz measured (' +
    measurementDeviation + ' ms deviation), ' + reportedHz +
    ' Hz sent, ' + streamFps + ' FPS requested';

  var syncLine;
  if (_presentationSupported === false) {
    syncLine = 'Display sync: presentation callback unavailable';
  } else if (_presentationIntervalCount < 2) {
    syncLine = 'Display sync: measuring presentation cadence';
  } else {
    var sum = 0;
    var sumSq = 0;
    for (var i = 0; i < _presentationIntervalCount; i++) {
      var interval = _presentationIntervals[i];
      sum += interval;
      sumSq += interval * interval;
    }
    var meanMs = sum / _presentationIntervalCount;
    var variance = (sumSq / _presentationIntervalCount) - (meanMs * meanMs);
    var presentedHz = meanMs > 0 ? 1000 / meanMs : 0;
    syncLine = 'Display sync: ' + presentedHz.toFixed(3) + ' Hz presented, ' +
      Math.sqrt(Math.max(0, variance)).toFixed(2) + ' ms deviation, ' +
      _presentationFrameGaps + ' frame gaps';
  }
  return [panelLine, syncLine];
}
