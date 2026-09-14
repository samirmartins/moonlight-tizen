'use strict';
const assert = require('assert'), fs = require('fs'), cp = require('child_process');
const current = fs.readFileSync('wasm/wasmplayer.cpp', 'utf8');
const baseline = cp.execFileSync('git', ['show', 'v3.3.8:wasm/wasmplayer.cpp'], {encoding: 'utf8'});
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
assert.strictEqual(section(current, '  // Assemble the packet.', '  if (appended) {'),
                   section(baseline, '  // Assemble the packet.', '  if (appended) {'),
                   'bitstream assembly, SPS fixup and AppendPacket parameters stay unchanged');
assert.strictEqual(section(current, wrapper, 'void MoonlightInstance::AddVideoStats'),
                   section(baseline, wrapper, 'void MoonlightInstance::AddVideoStats'));
// Revised 3.3.9 changes clock snapshots/calibration only. Freeze
// the unrelated paths, rather than claiming playback is identical to 3.3.8.
assert.strictEqual(section(current, '  int framesElapsed =', '// Folds the interval since the previous append'),
                   section(baseline, '  int framesElapsed =', '// Folds the interval since the previous append'),
                   'normal PTS rate window and servo correction must match 3.3.8');
assert.match(current, /\.capabilities = CAPABILITY_DIRECT_SUBMIT \| CAPABILITY_SLICES_PER_FRAME\(1\)/);
assert.strictEqual(cp.execFileSync('git', ['diff', 'v3.3.8', '--',
  'wasm/auddec.cpp', 'wasm/audio_ring.hpp',
  'moonlight-common-c/src/VideoDepacketizer.c', 'moonlight-common-c/src/VideoStream.c',
  'wasm/platform/audio.js', 'wasm/platform/audio-worklet.js',
  'wasm/platform/gamepad.js', 'wasm/gamepad.cpp', 'wasm/platform/display.js'], {encoding: 'utf8'}), '');
console.log('playback_baseline_test: ok (3.3.8 PTS window, direct submit, bitstream, audio, input and display preserved)');
