'use strict';
// Privacy-only frontend changes must not alter storage, pairing or launch data.
const fs=require('fs'),cp=require('child_process'),vm=require('vm'),assert=require('assert');
const contracts=fs.readFileSync('wasm/scope_contract_test.js','utf8');
const normalize=vm.runInNewContext('('+contracts.slice(contracts.indexOf('function withoutLogs'),contracts.indexOf('\n\n\n{')).trim()+')',{require});
const normalizeWake=vm.runInNewContext('('+contracts.slice(contracts.indexOf('function withoutInputWake'),contracts.indexOf('\n{\n')).trim()+')',{require});
const old=f=>cp.execFileSync('git',['show','v3.4.1:'+f],{encoding:'utf8'});
for(const f of ['wasm/platform/index.js','wasm/platform/messages.js','wasm/platform/common.js',
 'wasm/static/js/utils.js','wasm/static/js/mdns-browser/main.js']){
 assert.strictEqual(normalize(fs.readFileSync(f,'utf8')),normalize(old(f)),f+' only logging/start rejection');
}
for(const f of ['wasm/auddec.cpp','wasm/audio_ring.hpp','wasm/platform/audio.js','wasm/platform/audio-worklet.js',
 'wasm/platform/gamepad.js','wasm/gamepad.cpp','wasm/input.cpp','wasm/video_timing.hpp','wasm/video_telemetry.hpp',
 'wasm/platform/diagnostics.js','wasm/platform/display.js','wasm/platform/console-library.js',
 'wasm/platform/navigation.js','wasm/index.html','wasm/static/css/style.css','wasm/static/css/console-library.css',
 'moonlight-common-c/src/RtpVideoQueue.c','moonlight-common-c/src/VideoDepacketizer.c']){
 if(f==='wasm/gamepad.cpp') {
  // The authorized wake-only exception is also behaviorally tested; keep the
  // snapshot, mapping, network values and rumble frozen to the same baseline.
  assert.strictEqual(normalizeWake(fs.readFileSync(f,'utf8')),normalizeWake(old(f)),f+' approved wake-only change');
 } else assert.strictEqual(fs.readFileSync(f,'utf8'),old(f),f+' unchanged from published baseline');
}
function section(s,a,b){const start=s.indexOf(a),end=s.indexOf(b,start);assert(start>=0&&end>start);return s.slice(start,end);}
const main=fs.readFileSync('wasm/main.cpp','utf8');
assert.strictEqual(section(main,'  // Populate the stream configuration','  // Create the media source'),section(old('wasm/main.cpp'),'  // Populate the stream configuration','  // Create the media source'));
assert.strictEqual(section(main,'void* MoonlightInstance::InputThreadFunc','void* MoonlightInstance::ConnectionThreadFunc'),section(old('wasm/main.cpp'),'void* MoonlightInstance::InputThreadFunc','void* MoonlightInstance::ConnectionThreadFunc'));
for(const forbidden of ['Setting the Remote input key','Setting the RTSP session URL','using PIN:','with host address:','Setting the Host address']){
 assert(!main.includes(forbidden),forbidden);
}
const index=fs.readFileSync('wasm/platform/index.js','utf8');
assert.strictEqual((index.match(/handleMessage\('streamTerminated: 0'\);/g)||[]).length,2,'both native launch rejections recover the UI');
for(const forbidden of ['JSON.stringify(data)','readRequest.result','randomNumber','nvhttpHost.hostname','host.address']){
 for(const line of index.split('\n').filter(s=>s.includes('console.')))assert(!line.includes(forbidden),forbidden);
}
console.log('runtime_privacy_test: private log fields removed; storage/pairing/launch payload and healthy playback baseline preserved');
