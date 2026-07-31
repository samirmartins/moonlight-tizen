'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

(async function() {
  const memory = new SharedArrayBuffer(32768);
  const heap32 = new Int32Array(memory);
  const heap16 = new Int16Array(memory);
  const controlPtr = 0;
  const pcmPtr = 128;
  const capacity = 4096;
  const channels = 2;
  const control = new Int32Array(memory, controlPtr, 16);
  const pcm = new Int16Array(memory, pcmPtr, capacity * channels);
  pcm.fill(8000);
  control[0] = 0;
  control[1] = 3000;
  control[2] = 11;
  control[6] = 4;
  control[7] = -1;
  control[13] = 4;
  control[14] = 480;

  let scriptNode = null;
  let closed = false;
  const ctx = {
    state: 'running',
    sampleRate: 48000,
    destination: { maxChannelCount: 2 },
    createScriptProcessor: function(size, inputs, outputs) {
      assert.strictEqual(size, 1024);
      assert.strictEqual(inputs, 0);
      assert.strictEqual(outputs, 2);
      scriptNode = {
        onaudioprocess: null,
        connect: function() {},
        disconnect: function() {}
      };
      return scriptNode;
    },
    close: function() { closed = true; return Promise.resolve(); }
  };
  const context = {
    console: { log: function() {}, warn: function() {}, error: function() {} },
    window: { _mlAudioCtx: ctx },
    Module: { HEAP32: heap32, HEAP16: heap16 },
    performance: { now: function() { return 0; } },
    Promise,
    Int32Array,
    Int16Array,
    Atomics,
    Array,
    Math,
    Date,
    isFinite
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('wasm/platform/audio.js', 'utf8'), context);
  context.configureAudioScheduler(50, controlPtr, pcmPtr, capacity, channels, 48000, 11);
  await new Promise(function(resolve) { setImmediate(resolve); });
  assert(scriptNode && scriptNode.onaudioprocess);
  assert.strictEqual(Atomics.load(control, 3), 2);

  const channelData = [new Float32Array(1024), new Float32Array(1024)];
  const outputBuffer = {
    length: 1024,
    sampleRate: 48000,
    numberOfChannels: 2,
    getChannelData: function(channel) { return channelData[channel]; }
  };
  scriptNode.onaudioprocess({ outputBuffer });
  assert(channelData[0][0] > 0.2 && channelData[0][0] < 0.3);
  assert(Atomics.load(control, 0) >= 1020);

  context.stopAudioScheduler(true);
  assert.strictEqual(closed, true);
  assert.strictEqual(context.window._mlAudioCtx, null);
  console.log('audio_scheduler_test: ok');
})().catch(function(error) {
  console.error(error);
  process.exitCode = 1;
});
