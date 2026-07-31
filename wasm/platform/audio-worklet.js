/* global AudioWorkletProcessor, registerProcessor, sampleRate */

// Indexes into AudioRingControl in wasm/audio_ring.hpp.
var ML_AUD_READ = 0;
var ML_AUD_WRITE = 1;
var ML_AUD_GENERATION = 2;
var ML_AUD_MODE = 3;
var ML_AUD_UNDERRUNS = 4;
var ML_AUD_OVERRUNS = 5;
var ML_AUD_TARGET = 6;
var ML_AUD_MIN_DEPTH = 7;
var ML_AUD_MAX_DEPTH = 8;
var ML_AUD_CONSUMED = 9;
var ML_AUD_DRIFT_PPM = 10;
var ML_AUD_STARTED = 11;
var ML_AUD_EPOCH = 12;
var ML_AUD_INITIAL_TARGET = 13;
var ML_AUD_MAX_TARGET = 14;

function mlClamp(value, minimum, maximum) {
  return value < minimum ? minimum : (value > maximum ? maximum : value);
}

class MoonlightPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.control = null;
    this.pcm = null;
    this.capacity = 0;
    this.mask = 0;
    this.channels = 0;
    this.sourceRate = 48000;
    this.generation = 0;
    this.readFrame = 0;
    this.phase = 0.0;
    this.epoch = 0;
    this.started = false;
    this.stableOutputFrames = 0;
    this.statsCountdown = 0;

    this.port.onmessage = (event) => {
      var data = event.data || {};
      if (data.type === 'stop') {
        this.ready = false;
        this.started = false;
        return;
      }
      if (data.type !== 'init' || !data.memory) {
        return;
      }

      try {
        this.control = new Int32Array(data.memory, data.controlPtr, 16);
        this.pcm = new Int16Array(
          data.memory, data.pcmPtr, data.capacityFrames * data.channels);
        this.capacity = data.capacityFrames >>> 0;
        this.mask = this.capacity - 1;
        this.channels = data.channels >>> 0;
        this.sourceRate = data.sourceRate >>> 0;
        this.generation = data.generation >>> 0;
        this.readFrame = Atomics.load(this.control, ML_AUD_READ) >>> 0;
        this.epoch = Atomics.load(this.control, ML_AUD_EPOCH) >>> 0;
        this.phase = 0.0;
        this.started = false;
        this.stableOutputFrames = 0;
        this.ready = true;
      } catch (e) {
        this.ready = false;
        this.port.postMessage({ type: 'error', message: String(e) });
      }
    };
  }

  clear(outputs, from) {
    for (var channel = 0; channel < outputs.length; channel++) {
      outputs[channel].fill(0, from || 0);
    }
  }

  noteDepth(depth) {
    if (--this.statsCountdown > 0) {
      return;
    }
    this.statsCountdown = 16;

    var oldMin = Atomics.load(this.control, ML_AUD_MIN_DEPTH) >>> 0;
    while (depth < oldMin) {
      var observedMin = Atomics.compareExchange(
        this.control, ML_AUD_MIN_DEPTH, oldMin | 0, depth | 0) >>> 0;
      if (observedMin === oldMin) { break; }
      oldMin = observedMin;
    }

    var oldMax = Atomics.load(this.control, ML_AUD_MAX_DEPTH) >>> 0;
    while (depth > oldMax) {
      var observedMax = Atomics.compareExchange(
        this.control, ML_AUD_MAX_DEPTH, oldMax | 0, depth | 0) >>> 0;
      if (observedMax === oldMax) { break; }
      oldMax = observedMax;
    }
  }

  handleUnderrun(outputs, from) {
    this.clear(outputs, from);
    if (this.started) {
      Atomics.add(this.control, ML_AUD_UNDERRUNS, 1);
      var target = Atomics.load(this.control, ML_AUD_TARGET) >>> 0;
      var maximum = Atomics.load(this.control, ML_AUD_MAX_TARGET) >>> 0;
      var step = Math.max(1, Math.round(this.sourceRate * 0.005));
      Atomics.store(this.control, ML_AUD_TARGET,
        Math.min(maximum, target + step) | 0);
    }
    this.started = false;
    this.stableOutputFrames = 0;
    Atomics.store(this.control, ML_AUD_STARTED, 0);
  }

  process(inputs, outputList) {
    var outputs = outputList[0];
    if (!outputs || outputs.length === 0) {
      return true;
    }

    if (!this.ready || !this.control ||
        (Atomics.load(this.control, ML_AUD_MODE) | 0) !== 1 ||
        (Atomics.load(this.control, ML_AUD_GENERATION) >>> 0) !== this.generation) {
      this.clear(outputs, 0);
      return true;
    }

    var currentEpoch = Atomics.load(this.control, ML_AUD_EPOCH) >>> 0;
    if (currentEpoch !== this.epoch) {
      this.epoch = currentEpoch;
      this.readFrame = Atomics.load(this.control, ML_AUD_READ) >>> 0;
      this.phase = 0.0;
      this.started = false;
      this.stableOutputFrames = 0;
      Atomics.store(this.control, ML_AUD_STARTED, 0);
    }

    var writeFrame = Atomics.load(this.control, ML_AUD_WRITE) >>> 0;
    var depth = (writeFrame - this.readFrame) >>> 0;
    var target = Atomics.load(this.control, ML_AUD_TARGET) >>> 0;
    this.noteDepth(depth);

    if (!this.started) {
      if (depth < target + 2) {
        this.clear(outputs, 0);
        return true;
      }
      this.started = true;
      Atomics.store(this.control, ML_AUD_STARTED, 1);
    }

    var outputFrames = outputs[0].length;
    var driftPpm = Atomics.load(this.control, ML_AUD_DRIFT_PPM) | 0;
    var error = target > 0 ? (depth - target) / target : 0;
    var bufferPpm = mlClamp(Math.round(error * 10000), -3000, 7500);
    var totalPpm = mlClamp(bufferPpm + driftPpm, -5000, 10000);
    var stepRatio = (this.sourceRate / sampleRate) * (1 + totalPpm / 1000000);
    var consumedThisQuantum = 0;

    for (var frame = 0; frame < outputFrames; frame++) {
      var available = (writeFrame - this.readFrame) >>> 0;
      if (available < 2) {
        Atomics.store(this.control, ML_AUD_READ, this.readFrame | 0);
        Atomics.add(this.control, ML_AUD_CONSUMED, consumedThisQuantum | 0);
        this.handleUnderrun(outputs, frame);
        return true;
      }

      var first = this.readFrame & this.mask;
      var second = (this.readFrame + 1) & this.mask;
      var fraction = this.phase;
      var copyChannels = Math.min(outputs.length, this.channels);
      for (var channel = 0; channel < copyChannels; channel++) {
        var a = this.pcm[first * this.channels + channel];
        var b = this.pcm[second * this.channels + channel];
        outputs[channel][frame] = (a + (b - a) * fraction) / 32768.0;
      }
      for (var extra = copyChannels; extra < outputs.length; extra++) {
        outputs[extra][frame] = 0;
      }

      this.phase += stepRatio;
      var advance = Math.floor(this.phase);
      if (advance > 0) {
        this.phase -= advance;
        this.readFrame = (this.readFrame + advance) >>> 0;
        consumedThisQuantum += advance;
      }
    }

    Atomics.store(this.control, ML_AUD_READ, this.readFrame | 0);
    Atomics.add(this.control, ML_AUD_CONSUMED, consumedThisQuantum | 0);
    this.stableOutputFrames += outputFrames;

    // An underrun temporarily raises the target. After one stable minute, walk
    // it back towards the low-latency initial target in small 2.5 ms steps.
    if (this.stableOutputFrames >= sampleRate * 60) {
      this.stableOutputFrames = 0;
      var currentTarget = Atomics.load(this.control, ML_AUD_TARGET) >>> 0;
      var initialTarget = Atomics.load(this.control, ML_AUD_INITIAL_TARGET) >>> 0;
      if (currentTarget > initialTarget) {
        var reduce = Math.max(1, Math.round(this.sourceRate * 0.0025));
        Atomics.store(this.control, ML_AUD_TARGET,
          Math.max(initialTarget, currentTarget - reduce) | 0);
      }
    }

    return true;
  }
}

registerProcessor('moonlight-pcm', MoonlightPcmProcessor);
