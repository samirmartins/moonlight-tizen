'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let ProcessorClass = null;
class AudioWorkletProcessor {
  constructor() {
    this.port = { onmessage: null, postMessage: function() {} };
  }
}

const context = vm.createContext({
  AudioWorkletProcessor,
  registerProcessor: function(name, processor) {
    assert.strictEqual(name, 'moonlight-pcm');
    ProcessorClass = processor;
  },
  sampleRate: 48000,
  Int16Array,
  Int32Array,
  Atomics,
  Math,
  String
});
vm.runInContext(fs.readFileSync('wasm/platform/audio-worklet.js', 'utf8'), context);
assert(ProcessorClass);

const memory = new SharedArrayBuffer(4096);
const control = new Int32Array(memory, 0, 16);
const pcmPtr = 128;
const capacity = 512;
const channels = 2;
const pcm = new Int16Array(memory, pcmPtr, capacity * channels);
pcm.fill(12000);
control[2] = 7;   // generation
control[3] = 1;   // worklet mode
control[6] = 4;   // target
control[7] = -1;  // min depth sentinel
control[13] = 4;
control[14] = 480;
control[1] = 400; // write frame

const processor = new ProcessorClass();
processor.port.onmessage({ data: {
  type: 'init', memory, controlPtr: 0, pcmPtr, capacityFrames: capacity,
  channels, sourceRate: 48000, generation: 7
} });

let output = [[new Float32Array(128), new Float32Array(128)]];
assert.strictEqual(processor.process([], output), true);
assert(output[0][0][0] > 0.3 && output[0][0][0] < 0.4);
assert(Atomics.load(control, 0) >= 127);
assert.strictEqual(Atomics.load(control, 11), 1);

// Starvation is concealed with silence and raises the adaptive target.
Atomics.store(control, 1, Atomics.load(control, 0) + 1);
output = [[new Float32Array(128), new Float32Array(128)]];
processor.process([], output);
assert.strictEqual(output[0][0][0], 0);
assert.strictEqual(Atomics.load(control, 4), 1);
assert(Atomics.load(control, 6) > 4);
assert.strictEqual(Atomics.load(control, 11), 0);

processor.port.onmessage({ data: { type: 'stop' } });
output[0][0].fill(1);
processor.process([], output);
assert.strictEqual(output[0][0][0], 0);
console.log('audio_worklet_test: ok');
