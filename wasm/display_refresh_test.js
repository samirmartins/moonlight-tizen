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
  },
  getVideoPlaybackQuality: function() {
    return { droppedVideoFrames: 0 };
  }
};
context.startVideoPresentationObserver(video);
let presentedFrames = 0;
let presentationTime = 500;
for (let i = 0; i < 125; i++) {
  const current = videoCallback;
  const frameDelta = i === 60 ? 2 : 1;
  presentedFrames += frameDelta;
  presentationTime += frameDelta * (1000 / 59.94);
  current(presentationTime, {
    expectedDisplayTime: presentationTime,
    presentedFrames
  });
}
let telemetry = context.getDisplayTelemetryCompact();
assert.match(telemetry.text, /D p\/s\/o 59\.9\d\d\/59\.94\/59\.94Hz d0\.00 drop0/);
assert.strictEqual(telemetry.fps, '59.94');
context.stopVideoPresentationObserver();

context.startVideoPresentationObserver({});
telemetry = context.getDisplayTelemetryCompact();
assert.match(telemetry.text, /\/--Hz d-- drop--$/);
assert.strictEqual(telemetry.fps, '--');
console.log('display_refresh_test: ok');
