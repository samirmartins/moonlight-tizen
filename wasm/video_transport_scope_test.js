'use strict';
const assert = require('assert'), fs = require('fs'), cp = require('child_process');
const scope = require('./video-transport-scope.cjs');
for (const file of scope.files) {
  const source = fs.readFileSync(file, 'utf8');
  const baseline = file.endsWith('/VideoRecoveryLog.h') ? '' : cp.execFileSync('git', ['show', 'v3.4.9:' + file], {encoding: 'utf8'});
  assert.strictEqual(scope.normalize(file, source), baseline, file);
  for (const mutation of [source + '\n// unknown edit\n', source.replace(/return|if/, 'unknown_mutation')])
    assert.notStrictEqual(scope.normalize(file, mutation), baseline, 'unapproved edit cannot be hidden: ' + file);
}
for (const file of ['wasm/wasmplayer.cpp', 'wasm/auddec.cpp', 'wasm/audio_ring.hpp', 'wasm/video_timing.hpp',
  'wasm/platform/audio.js', 'wasm/platform/audio-worklet.js', 'wasm/platform/gamepad.js', 'wasm/gamepad.cpp',
  'wasm/platform/diagnostics.js', 'wasm/platform/index.js', 'wasm/platform/console-library.js',
  'wasm/index.html', 'moonlight-common-c/reedsolomon/rs.c']) {
  assert.strictEqual(require('./branding-scope.cjs').normalize(file, fs.readFileSync(file, 'utf8')), cp.execFileSync('git', ['show', 'v3.4.9:' + file], {encoding: 'utf8'}), file + ' must match stable outside approved branding');
}
console.log('video_transport_scope_test: exact tested video/refresh changes; audio/PTS/rumble/input/overlay/FEC math unchanged; branding-only UI exceptions');
