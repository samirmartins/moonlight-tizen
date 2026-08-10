'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = {
  console: { log: function() {} },
  Module: {},
  Math,
  Date,
  isFinite,
  window: null
};
context.window = context;
context.getDisplayTelemetryCompact = function() {
  return {
    fps: '59.97',
    text: 'D p/s/o 59.968/59.94/59.97Hz d0.62 drop0'
  };
};
context.getAudioTelemetryLine = function() {
  return 'Aud: AW q99/100ms U0 O0';
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('wasm/platform/messages.js', 'utf8'), context);

const nativeText = [
  'Str: 2560x1440 HEVC 60fps 36.2Mb',
  'FPS H/R/S/O: 60.00/59.99/59.99/@PFPS@',
  'Net: loss 0.00% RTT 2+/-1ms apprej 0',
  'Host: i16.67 p17.00 d0.50ms l0.0% enc 5.2/8.0ms',
  'Load a/p/x: 75/142/261KB 55/104/191pkts',
  'Work a/p/x: asm 0.12/0.35/1.20 app 0.40/0.80/3.10ms zc0%',
  'Cad: d1.80 p19.20 x30.10ms l5.5% H3.2/m T18.7/31.0s b2',
  'Pipe a/p/x: 11.0/18.0/30.0ms r0 | @DISP@'
].join('\n');

const overlay = context.formatPerformanceOverlay(nativeText);
const lines = overlay.split('\n');
assert.strictEqual(lines.length, 9);
assert.match(lines[1], /\/59\.97$/);
assert.match(lines[7], /59\.968\/59\.94\/59\.97Hz/);
assert.strictEqual(lines[8], 'Aud: AW q99/100ms U0 O0');
assert.ok(lines.every(function(line) { return line.length < 120; }));
assert.ok(overlay.indexOf('@PFPS@') === -1);
assert.ok(overlay.indexOf('@DISP@') === -1);

console.log('performance_overlay_test: ok');
