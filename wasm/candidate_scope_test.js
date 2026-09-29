'use strict';
const fs=require('fs'),cp=require('child_process'),assert=require('assert');
const baseline=cp.execFileSync('git',['show','v3.3.9:wasm/wasmplayer.cpp'],{encoding:'utf8'});
const current=fs.readFileSync('wasm/wasmplayer.cpp','utf8');
const start='    if (videoFormat & VIDEO_FORMAT_H264) {';
const end='    } else if (videoFormat & (VIDEO_FORMAT_H265 | VIDEO_FORMAT_H265_MAIN10)) {';
function split(s){const a=s.indexOf(start),b=s.indexOf(end,a);assert(a>=0&&b>a);return [s.slice(0,a),s.slice(a,b),s.slice(b)];}
const old=split(baseline),now=split(current);
const padOld=cp.execFileSync('git',['show','v3.3.9:wasm/platform/gamepad.js'],{encoding:'utf8'});
const padNew=fs.readFileSync('wasm/platform/gamepad.js','utf8');
const marker='// Rumble is sampled cheaply in rAF';
assert.strictEqual(padNew.split(marker)[0],padOld.split(marker)[0]);
for(const name of ['DURATION_MS','RENEW_MS','MIN_INTERVAL_MS','MAX_IN_FLIGHT','WATCHDOG_MS']) {
  const re=new RegExp('var _RUMBLE_'+name+' = [0-9]+;');
  assert.strictEqual(padNew.match(re)[0],padOld.match(re)[0]);
}
assert.strictEqual(old[0],now[0]);assert.strictEqual(old[2],now[2]);
assert.match(now[1],/width == 2560 && height == 1440 && redrawRate <= 60/);
assert.match(now[1],/avc1\.640033/);assert.match(now[1],/else\s*\{\s*mimetypes.push_back\("video\/mp4; codecs=\\"avc1\.64002A/);
const frozen=['wasm/auddec.cpp','wasm/audio_ring.hpp','wasm/platform/audio.js','wasm/platform/audio-worklet.js',
  'wasm/input.cpp','wasm/gamepad.cpp','wasm/main.cpp','wasm/video_timing.hpp','moonlight-common-c',
  'wasm/platform/diagnostics.js','wasm/platform/display.js','wasm/platform/index.js','wasm/static'];
assert.strictEqual(cp.execFileSync('git',['diff','v3.3.9','--',...frozen],{encoding:'utf8'}),'');
console.log('candidate_scope_test: H264 change isolated; AV1/HEVC, PTS, audio, input, native rumble, RTP, UI and telemetry preserved');
