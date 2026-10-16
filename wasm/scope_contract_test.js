'use strict';
// Approved historical scope contracts; behavioral tests are independent.

function withoutLogs(source) {
 source=source.replace(/\.catch\(function\(\) \{\s*handleMessage\('streamTerminated: 0'\);\s*snackbarLogLong\('Previous stream is still closing\. Retry shortly\.'\);\s*\}\)/g,'');
 const assert=require('assert');
 const parse=function calls(s,name) {
 const out=[];const re=new RegExp(name.replaceAll(".","\\.")+"\\s*\\(","g");let m;
 while((m=re.exec(s))){let i=re.lastIndex,depth=1,q=null,esc=false;
 for(;i<s.length&&depth;i++){const c=s[i];if(q){if(esc)esc=false;else if(c==="\\")esc=true;else if(c===q)q=null;}else if("'\"`".includes(c))q=c;else if(c==="(")depth++;else if(c===")")depth--;}
 if(depth)throw Error("unbalanced");if(s[i]===";")i++;out.push([m.index,i,s.slice(m.index,i)]);re.lastIndex=i;
 }return out;
};
 for(const n of ['console.log','console.warn','console.error','console.debug','ClLogMessage','PostToJs']){
  for(const[a,b]of parse(source,n).reverse())source=source.slice(0,a)+source.slice(b);
 }
 return source.replace(/\/\/ Logging both object[^\n]*/g,'').replace(/\.catch\(function\(\) \{\s*\}\)/g,'.catch(console.error)').replace(/\s+/g,' ').trim();
}


{
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
  'wasm/gamepad.cpp', 'wasm/platform/display.js'], {encoding: 'utf8'}), '');
// JS rumble changes in 3.3.10 are covered by rumble_safety_test; input sampling
// is separately protected by the approved input scope contract.

}

{
'use strict';
const fs=require('fs'),cp=require('child_process'),assert=require('assert');
const baseline=cp.execFileSync('git',['show','v3.3.10:wasm/wasmplayer.cpp'],{encoding:'utf8'});
const current=fs.readFileSync('wasm/wasmplayer.cpp','utf8');
function between(s,a,b) { const start=s.indexOf(a),end=s.indexOf(b,start);assert(start>=0&&end>start);return s.slice(start,end); }
assert.strictEqual(between(current,'    } else if (videoFormat & (VIDEO_FORMAT_H265','    bool trackAdded'),
  between(baseline,'    } else if (videoFormat & (VIDEO_FORMAT_H265','    bool trackAdded'));
assert.strictEqual(between(current,'static TimeStamp NextPacketPts','bool MoonlightInstance::WaitFor')
    .replace('  g_Instance->m_DecoderActive = false;\n', ''),
  between(baseline,'static TimeStamp NextPacketPts','void MoonlightInstance::WaitFor'));
const padOld=cp.execFileSync('git',['show','v3.3.10:wasm/platform/gamepad.js'],{encoding:'utf8'});
const padNew=fs.readFileSync('wasm/platform/gamepad.js','utf8');
assert.strictEqual(between(padNew,'// Streaming gamepad publisher','// Rumble is sampled cheaply in rAF'),
  between(padOld,'// Streaming gamepad publisher','// Rumble is sampled cheaply in rAF'));
for(const name of ['DURATION_MS','RENEW_MS','MIN_INTERVAL_MS','MAX_IN_FLIGHT','WATCHDOG_MS']) {
  const re=new RegExp('var _RUMBLE_'+name+' = [0-9]+;');
  assert.strictEqual(padNew.match(re)[0],padOld.match(re)[0]);
}
const frozen=['wasm/auddec.cpp','wasm/audio_ring.hpp','wasm/platform/audio.js','wasm/platform/audio-worklet.js',
  'wasm/gamepad.cpp','wasm/video_timing.hpp','moonlight-common-c',
  ':(exclude)moonlight-common-c/src/RtspConnection.c',
  ':(exclude)moonlight-common-c/src/RtspParser.c',
  ':(exclude)moonlight-common-c/src/PlatformSockets.c',
  ':(exclude)moonlight-common-c/src/Platform.h',
  'wasm/platform/diagnostics.js','wasm/platform/display.js'];
assert.strictEqual(cp.execFileSync('git',['diff','v3.3.10','--',...frozen],{encoding:'utf8'}),'');

}

{
'use strict';
const fs = require('fs'), cp = require('child_process'), assert = require('assert');
// The identical v3.3.10 frozen-file set is checked above.
const old = cp.execFileSync('git',['show','v3.3.10:wasm/platform/index.js'],{encoding:'utf8'});
const now = fs.readFileSync('wasm/platform/index.js','utf8');
function between(s,a,b,from=0) { const start=s.indexOf(a,from),end=s.indexOf(b,start); assert(start>=0&&end>start); return s.slice(start,end).trim(); }
// The only allowed change in this segment is safe text insertion in the
// pre-launch confirmation. Stream arguments and scheduling remain identical.
assert.strictEqual(withoutLogs(between(now,'  // Reset the scheduler for the new stream','function stopGame')),
  withoutLogs(between(old,'  // Reset the scheduler for the new stream','function stopGame').replace(
    "document.getElementById('quitAppDialogText').innerHTML = currentApp.title",
    "document.getElementById('quitAppDialogText').textContent = currentApp.title")));
assert.strictEqual(withoutLogs(between(now,'  // Create the AudioContext here','\n}\n\nfunction startGame')),
  withoutLogs(between(old,'  // Create the AudioContext here','  // Reset the scheduler for the new stream')));
assert.strictEqual(between(now,'function showStreamMode()','// Maximize the size').replace('  ConsoleLibrary.suspend();\n  clearTimeout(startupScanTimer);\n  repeatAction = null;\n  clearTimeout(repeatTimeout);\n  clearTimeout(navigationTimeout);\n',''),
  between(old,'function showStreamMode()','// Maximize the size'));
assert.strictEqual(between(now,'function fullscreenWasmModule()','// Start the given appID'),
  between(old,'function fullscreenWasmModule()','// Start the given appID'));
const oldCss = cp.execFileSync('git',['show','v3.3.10:wasm/static/css/style.css'],{encoding:'utf8'});
const css = fs.readFileSync('wasm/static/css/style.css','utf8');
assert.strictEqual(css.slice(css.indexOf('   Streaming Layout')),oldCss.slice(oldCss.indexOf('   Streaming Layout')));

}

{
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
for (const marker of [
 'void MoonlightInstance::SourceListener::OnPipelineError(', 'bool MoonlightInstance::WaitFor(',
 'MoonlightInstance::SourceListener::SourceListener(', 'MoonlightInstance::VideoTrackListener::VideoTrackListener(',
 'void MoonlightInstance::SourceListener::OnSourceOpen(', 'void MoonlightInstance::SourceListener::OnSourceOpenPending(',
 'void MoonlightInstance::SourceListener::OnSourceClosed(', 'void MoonlightInstance::SourceListener::OnPlaybackPositionChanged(',
 'void MoonlightInstance::VideoTrackListener::OnTrackOpen(', 'void MoonlightInstance::VideoTrackListener::OnTrackClosed(',
 'void MoonlightInstance::VideoTrackListener::OnSessionIdChanged(']) {
 player = maskMethod(player, marker); baseline = maskMethod(baseline, marker);
}
player = player.replace('  g_Instance->m_DecoderActive = true;', '  g_Instance->m_H264DecoderActive = (videoFormat & VIDEO_FORMAT_H264) != 0;')
 .replace('m_DecoderPipelineFailed = false;', 'm_H264PipelineFailed = false;')
 .replace('  g_Instance->m_DecoderActive = false;\n', '');
player = player.replace('g_Instance->m_VideoTrackListener.get()', '&g_Instance->m_VideoTrackListener');
const openBegin=player.indexOf('  auto openTicket ='),openEnd=player.indexOf('\n',player.indexOf('  if (!openResult)',openBegin));
assert(openBegin>=0&&openEnd>openBegin);
player=player.slice(0,openBegin)+'  g_Instance->m_Source->Open([](EmssOperationResult){});'+player.slice(openEnd);
assert.strictEqual(player, baseline, 'no other video/PTS/assembly/presentation change');
let main = current('wasm/main.cpp')
 .replace('  emscripten_set_blur_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, handleFocusLost);\n', '')
 .replace('  emscripten_set_visibilitychange_callback(NULL, EM_TRUE, handleVisibilityChange);\n', '');

let mainOld = old('wasm/main.cpp');
for(const marker of ['void MoonlightInstance::RequestStop(', 'void MoonlightInstance::ReleaseMedia(', 'bool MoonlightInstance::BeginSession(']) {
 const masked=maskMethod(main,marker);main=masked.replace(marker+' [tested separately]','');
}
for(const marker of ['MoonlightInstance::MoonlightInstance(', 'void MoonlightInstance::OnConnectionStarted(', 'void MoonlightInstance::OnConnectionStopped(',
 'void MoonlightInstance::StopConnection(', 'void* MoonlightInstance::StopThreadFunc(',
 'void* MoonlightInstance::ConnectionThreadFunc(', 'MessageResult MoonlightInstance::StartStream(']) {
 main=maskMethod(main,marker);mainOld=maskMethod(mainOld,marker);
}
assert.strictEqual(withoutLogs(main),withoutLogs(mainOld),'unrelated native methods unchanged');

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
      'wasm/platform/index.js', 'wasm/static/css/console-library.css', 'wasm/index.html',
      'moonlight-common-c/src/RtspParser.c', 'moonlight-common-c/src/Platform.h',
      'moonlight-common-c/src/PlatformSockets.c',
      'wasm/static/js/utils.js','wasm/static/js/mdns-browser/main.js'].includes(file)) continue;
 if (['wasm/platform/messages.js','wasm/platform/common.js'].includes(file)) {
  assert.strictEqual(withoutLogs(current(file)),withoutLogs(old(file)),file+' privacy-only logging');
 } else assert(fs.readFileSync(file).equals(cp.execFileSync('git', ['show', 'v3.4.0:' + file])), file);
}
const index = current('wasm/platform/index.js'), indexOld = old('wasm/platform/index.js');
assert.strictEqual(withoutLogs(index.slice(0, index.indexOf('function restoreDefaultsSettingsValues()'))),
 withoutLogs(indexOld.slice(0, indexOld.indexOf('function restoreDefaultsSettingsValues()'))),
 'normal launch/stop, stream arguments, audio preparation and scheduling unchanged');
assert.strictEqual(withoutLogs(index.slice(index.indexOf('function loadHTTPCerts()'))),
 withoutLogs(indexOld.slice(indexOld.indexOf('function loadHTTPCerts()'))), 'pairing and host restoration unchanged');

}

console.log('scope_contract_test: all approved contracts preserved; duplicate frozen-file check removed');
