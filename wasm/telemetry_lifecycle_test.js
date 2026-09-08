'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm');
let enabled = false, start = 0, stop = 0, paints = 0, nativeId;
const switchElement = { MaterialSwitch: { on() { enabled = true; }, off() { enabled = false; } } };
const c = {
  console: { log() {} }, isInGame: true, document: { getElementById() { return {}; } },
  Module: { wakeOnLan(id) { nativeId = id; } },
  startVideoPresentationObserver() { start++; }, stopVideoPresentationObserver() { stop++; },
  savePerformanceStats() {}, SessionDiagnostics: { sample() {} },
  getAudioTelemetryLine() { return 'Aud: --'; },
  $(selector) {
    return { 0: switchElement, prop() { return enabled; }, css() { return this; },
      text() { if (selector === '#performance-stats') paints++; return this; } };
  }
};
vm.createContext(c);
vm.runInContext(fs.readFileSync('wasm/platform/messages.js', 'utf8'), c);
c.handleMessage('StatMsg: old sample');
assert.strictEqual(enabled, false); assert.strictEqual(start + paints, 0);
c.handleMessage('OverlayState: 1');
assert.strictEqual(enabled, true); assert.strictEqual(start, 1);
c.handleMessage('StatMsg: current sample');
assert.strictEqual(paints, 1);
c.handleMessage('OverlayState: 0');
const before = paints;
c.handleMessage('StatMsg: delayed sample');
assert.strictEqual(enabled, false); assert.strictEqual(start, 1); assert.strictEqual(stop, 1);
assert.strictEqual(paints, before);
c.isInGame = false; c.handleMessage('OverlayState: 1');
assert.strictEqual(enabled, false);
(async () => {
  const p = c.sendMessage('wakeOnLan', ['12:34:56:78:9A:BC']);
  const result = p.catch(e => e.message);
  assert.strictEqual(Object.keys(c.callbacks).length, 1);
  p.cancel();
  assert.match(await result, /cancelled/);
  assert.strictEqual(Object.keys(c.callbacks).length, 0);
  c.handlePromiseMessage(nativeId, 'resolve', 'late');
  await c.sendMessage('missingBinding', []).catch(() => {});
  assert.strictEqual(Object.keys(c.callbacks).length, 0);
  const success = c.sendMessage('wakeOnLan', ['12:34:56:78:9A:BC']);
  c.handlePromiseMessage(nativeId, 'resolve', 'sent');
  assert.strictEqual(await success, 'sent');
  assert.strictEqual(Object.keys(c.callbacks).length, 0);
  console.log('telemetry_lifecycle_test: ok');
})().catch(e => { console.error(e); process.exitCode = 1; });
