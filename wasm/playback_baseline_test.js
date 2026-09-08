'use strict';
const assert = require('assert'), fs = require('fs'), cp = require('child_process');
const current = fs.readFileSync('wasm/wasmplayer.cpp', 'utf8');
const baseline = cp.execFileSync('git', ['show', 'v3.3.7:wasm/wasmplayer.cpp'], {encoding: 'utf8'});
function section(text, begin, end) {
  const start = text.indexOf(begin);
  assert.ok(start !== -1);
  const stop = text.indexOf(end, start + begin.length);
  assert.ok(stop > start);
  return text.slice(start, stop);
}
function removeInstrumentedBlocks(text) {
  const marker = 'if constexpr (CollectStats) {';
  while (text.includes(marker)) {
    const start = text.indexOf(marker);
    let pos = start + marker.length, depth = 1;
    while (depth && pos < text.length) {
      const c = text[pos++];
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    assert.strictEqual(depth, 0);
    text = text.slice(0, start) + text.slice(pos);
  }
  return text;
}
const template = 'template<bool CollectStats>\nint MoonlightInstance::VidDecSubmitDecodeUnitImpl';
const wrapper = 'int MoonlightInstance::VidDecSubmitDecodeUnit(';
assert.strictEqual(
  removeInstrumentedBlocks(section(current, template, wrapper)),
  removeInstrumentedBlocks(section(baseline, template, wrapper)),
  'non-instrumented submit path must remain identical to v3.3.7');
assert.strictEqual(section(current, wrapper, 'void MoonlightInstance::AddVideoStats'),
                   section(baseline, wrapper, 'void MoonlightInstance::AddVideoStats'));
// Everything before the telemetry submit template includes PTS, servo,
// playback-position callbacks, setup and recovery: no changes permitted.
assert.strictEqual(current.slice(0, current.indexOf(template)), baseline.slice(0, baseline.indexOf(template)));
assert.strictEqual(cp.execFileSync('git', ['diff', 'v3.3.7', '--',
  'moonlight-common-c', 'wasm/auddec.cpp', 'wasm/audio_ring.hpp',
  'wasm/platform/audio.js', 'wasm/platform/audio-worklet.js',
  'wasm/platform/gamepad.js', 'wasm/gamepad.cpp', 'wasm/platform/display.js'], {encoding: 'utf8'}), '');
console.log('playback_baseline_test: ok (v3.3.7 non-instrumented playback preserved)');
