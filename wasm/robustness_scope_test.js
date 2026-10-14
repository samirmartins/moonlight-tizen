'use strict';
// Keep the approved 3.4.0 streaming implementation byte-for-byte except for
// the explicitly authorized error/lifecycle and held-input changes.
const fs = require('fs'), cp = require('child_process'), assert = require('assert');
function old(file) { return cp.execFileSync('git', ['show', 'v3.4.0:' + file], {encoding: 'utf8'}); }
function current(file) { return fs.readFileSync(file, 'utf8'); }
function maskMethod(source, marker) {
 const start = source.indexOf(marker); assert(start >= 0, marker);
 let end = source.indexOf('{', start) + 1, depth = 1;
 while (depth) { const c = source[end++]; if (c === '{') depth++; else if (c === '}') depth--; assert(end <= source.length); }
 return source.slice(0, start) + marker + ' [tested separately]' + source.slice(end);
}
let player = current('wasm/wasmplayer.cpp'), baseline = old('wasm/wasmplayer.cpp');
for (const marker of ['void MoonlightInstance::SourceListener::OnPipelineError(', 'bool MoonlightInstance::WaitFor(']) {
 player = maskMethod(player, marker); baseline = maskMethod(baseline, marker);
}
player = player.replace('  g_Instance->m_DecoderActive = true;', '  g_Instance->m_H264DecoderActive = (videoFormat & VIDEO_FORMAT_H264) != 0;')
 .replace('m_DecoderPipelineFailed = false;', 'm_H264PipelineFailed = false;')
 .replace('  g_Instance->m_DecoderActive = false;\n', '');
assert.strictEqual(player, baseline, 'no other video/PTS/assembly/presentation change');
const main = current('wasm/main.cpp')
 .replace('  emscripten_set_blur_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, handleFocusLost);\n', '')
 .replace('  emscripten_set_visibilitychange_callback(NULL, EM_TRUE, handleVisibilityChange);\n', '');
assert.strictEqual(main, old('wasm/main.cpp'), 'stream launch/stop and input worker unchanged');
const input = current('wasm/input.cpp'), inputOld = old('wasm/input.cpp');
function extract(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
for (const [start, end] of [
 ['EM_BOOL MoonlightInstance::HandleMouseMove', 'EM_BOOL MoonlightInstance::HandleMouseUp'],
 ['EM_BOOL MoonlightInstance::HandleWheel', 'EM_BOOL MoonlightInstance::HandleKeyDown'],
 ['void MoonlightInstance::ReportMouseMovement', 'void MoonlightInstance::MouseLockLost']
]) assert.strictEqual(extract(input, start, end), extract(inputOld, start, end));
for (const [marker, action] of [
 ['EM_BOOL MoonlightInstance::HandleKeyDown', 'KEY_ACTION_DOWN'],
 ['EM_BOOL MoonlightInstance::HandleKeyUp', 'KEY_ACTION_UP']
]) {
 const next = marker.includes('Down') ? 'EM_BOOL MoonlightInstance::HandleKeyUp' : 'EM_BOOL handleKeyDown';
 assert.strictEqual(extract(input, marker, next).replace(
   '  SendKeyboardInput(keyCode, ' + action + ', modifiers);',
   '  LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, ' + action + ', modifiers);'), extract(inputOld, marker, next));
}
const files = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', 'v3.4.0', '--',
 'moonlight-common-c', 'libgamestream', 'wasm/platform', 'wasm/static', 'wasm/index.html',
 'wasm/auddec.cpp', 'wasm/audio_ring.hpp', 'wasm/gamepad.cpp', 'wasm/video_timing.hpp', 'wasm/video_telemetry.hpp'], {encoding: 'utf8'}).trim().split('\n');
for (const file of files) {
 if (['moonlight-common-c/src/RtspConnection.c', 'wasm/platform/console-library.js',
      'wasm/platform/index.js', 'wasm/static/css/console-library.css', 'wasm/index.html'].includes(file)) continue;
 assert(fs.readFileSync(file).equals(cp.execFileSync('git', ['show', 'v3.4.0:' + file])), file);
}
const index = current('wasm/platform/index.js'), indexOld = old('wasm/platform/index.js');
assert.strictEqual(index.slice(0, index.indexOf('function restoreDefaultsSettingsValues()')),
 indexOld.slice(0, indexOld.indexOf('function restoreDefaultsSettingsValues()')),
 'normal launch/stop, stream arguments, audio preparation and scheduling unchanged');
assert.strictEqual(index.slice(index.indexOf('function loadHTTPCerts()')),
 indexOld.slice(indexOld.indexOf('function loadHTTPCerts()')), 'pairing and host restoration unchanged');
console.log('robustness_scope_test: normal video/audio/input movement, RTP/FEC, HTTP, stream arguments, rumble and telemetry preserved; menu startup/defaults scoped separately');
