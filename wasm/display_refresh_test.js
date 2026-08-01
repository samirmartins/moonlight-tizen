'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let callback = null;
const context = {
  console: { log: function() {} },
  Date,
  Math,
  isFinite,
  window: null
};
context.window = context;
context.requestAnimationFrame = function(cb) { callback = cb; return 1; };
context.cancelAnimationFrame = function() { callback = null; };
vm.createContext(context);
vm.runInContext(fs.readFileSync('wasm/platform/display.js', 'utf8'), context);

context.startDisplayRefreshEstimator();
let timestamp = 100;
for (let i = 0; i < 245 && callback; i++) {
  const current = callback;
  timestamp += (i === 80 ? 100 : 1000 / 59.94); // one rejected suspension outlier
  current(timestamp);
}
assert.strictEqual(context.getDisplayRefreshRateX100(60), 5994);
assert.strictEqual(context.window._mlDisplayRefreshX100, 5994);
assert.ok(context.window._mlDisplayRefreshRawHz > 59.9);
assert.ok(context.window._mlDisplayRefreshRawHz < 60.0);

context.setDisplayStreamReference(60, 5994);
let videoCallback = null;
let callbackId = 0;
const video = {
  requestVideoFrameCallback: function(cb) {
    videoCallback = cb;
    return ++callbackId;
  },
  cancelVideoFrameCallback: function() {
    videoCallback = null;
  }
};
context.startVideoPresentationObserver(video);
let presentedFrames = 0;
for (let i = 0; i < 125; i++) {
  const current = videoCallback;
  presentedFrames += (i === 60 ? 2 : 1);
  current(i * (1000 / 59.94), {
    expectedDisplayTime: 500 + i * (1000 / 59.94),
    presentedFrames
  });
}
let telemetry = context.getDisplayTelemetryLines();
assert.match(telemetry[0], /59\.9\d\d Hz measured \(0\.\d\d ms deviation\), 59\.94 Hz sent, 60\.00 FPS requested/);
assert.match(telemetry[1], /59\.940 Hz presented, 0\.00 ms deviation, 1 frame gaps/);
context.stopVideoPresentationObserver();

context.startVideoPresentationObserver({});
telemetry = context.getDisplayTelemetryLines();
assert.strictEqual(telemetry[1], 'Display sync: presentation callback unavailable');
console.log('display_refresh_test: ok');
