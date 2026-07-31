// Measures the cadence at which this browser actually presents animation
// frames. The result is sent to Sunshine as clientRefreshRateX100, allowing the
// encoder cadence to follow the TV rather than assuming that the selected
// stream FPS is also the panel refresh rate.
//
// This is capability-based and deliberately model-agnostic. It runs only in
// menus, rejects suspended/background samples, and stops once enough stable
// data has been collected so it cannot compete with streaming.
var _displayRefreshX100 = 0;
var _displayRefreshSamples = [];
var _displayRefreshRaf = 0;
var _displayRefreshLast = 0;
var _displayRefreshDeadline = 0;

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
  var count = 0;
  for (var i = trim; i < samples.length - trim; i++) {
    sum += samples[i];
    count++;
  }
  if (count > 0 && sum > 0) {
    var hz = _displaySnapRefresh(1000 / (sum / count));
    _displayRefreshX100 = Math.round(hz * 100);
    window._mlDisplayRefreshX100 = _displayRefreshX100;
    console.log('%c[display.js]', 'color: green;',
      'Measured display cadence: ' + (_displayRefreshX100 / 100).toFixed(2) + ' Hz');
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
