'use strict';
const fs = require('fs'), cp = require('child_process'), assert = require('assert');
const frozen = ['wasm/auddec.cpp','wasm/audio_ring.hpp',
  'wasm/platform/audio.js','wasm/platform/audio-worklet.js',
  'wasm/platform/diagnostics.js','wasm/platform/display.js','wasm/input.cpp','wasm/gamepad.cpp',
  'wasm/video_timing.hpp','moonlight-common-c'];
assert.strictEqual(cp.execFileSync('git',['diff','v3.3.10','--',...frozen],{encoding:'utf8'}),'');
const old = cp.execFileSync('git',['show','v3.3.10:wasm/platform/index.js'],{encoding:'utf8'});
const now = fs.readFileSync('wasm/platform/index.js','utf8');
function between(s,a,b,from=0) { const start=s.indexOf(a,from),end=s.indexOf(b,start); assert(start>=0&&end>start); return s.slice(start,end).trim(); }
// The only allowed change in this segment is safe text insertion in the
// pre-launch confirmation. Stream arguments and scheduling remain identical.
assert.strictEqual(between(now,'  // Reset the scheduler for the new stream','function stopGame'),
  between(old,'  // Reset the scheduler for the new stream','function stopGame').replace(
    "document.getElementById('quitAppDialogText').innerHTML = currentApp.title",
    "document.getElementById('quitAppDialogText').textContent = currentApp.title"));
assert.strictEqual(between(now,'  // Create the AudioContext here','\n}\n\nfunction startGame'),
  between(old,'  // Create the AudioContext here','  // Reset the scheduler for the new stream'));
assert.strictEqual(between(now,'function showStreamMode()','// Maximize the size').replace('  ConsoleLibrary.suspend();\n  clearTimeout(startupScanTimer);\n  repeatAction = null;\n  clearTimeout(repeatTimeout);\n  clearTimeout(navigationTimeout);\n',''),
  between(old,'function showStreamMode()','// Maximize the size'));
assert.strictEqual(between(now,'function fullscreenWasmModule()','// Start the given appID'),
  between(old,'function fullscreenWasmModule()','// Start the given appID'));
const oldCss = cp.execFileSync('git',['show','v3.3.10:wasm/static/css/style.css'],{encoding:'utf8'});
const css = fs.readFileSync('wasm/static/css/style.css','utf8');
assert.strictEqual(css.slice(css.indexOf('   Streaming Layout')),oldCss.slice(oldCss.indexOf('   Streaming Layout')));
console.log('console_library_scope_test: audio/input/RTP/telemetry, stream arguments and audio preparation preserved');
