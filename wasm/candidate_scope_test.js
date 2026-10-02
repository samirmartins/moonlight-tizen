'use strict';
const fs=require('fs'),cp=require('child_process'),assert=require('assert');
const baseline=cp.execFileSync('git',['show','v3.3.10:wasm/wasmplayer.cpp'],{encoding:'utf8'});
const current=fs.readFileSync('wasm/wasmplayer.cpp','utf8');
function between(s,a,b) { const start=s.indexOf(a),end=s.indexOf(b,start);assert(start>=0&&end>start);return s.slice(start,end); }
assert.strictEqual(between(current,'    } else if (videoFormat & (VIDEO_FORMAT_H265','    bool trackAdded'),
  between(baseline,'    } else if (videoFormat & (VIDEO_FORMAT_H265','    bool trackAdded'));
assert.strictEqual(between(current,'static TimeStamp NextPacketPts','bool MoonlightInstance::WaitFor'),
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
  'wasm/input.cpp','wasm/gamepad.cpp','wasm/video_timing.hpp','moonlight-common-c',
  'wasm/platform/diagnostics.js','wasm/platform/display.js'];
assert.strictEqual(cp.execFileSync('git',['diff','v3.3.10','--',...frozen],{encoding:'utf8'}),'');
console.log('candidate_scope_test: HEVC/AV1, PTS/submit, audio, streaming input, RTP and telemetry preserved');
