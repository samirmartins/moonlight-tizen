'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const listeners = {};
let rafCallback = null;
let timerCallback = null;
let now = 0;
let notifications = 0;
let rumbleCalls = [];

function makeButtons() {
  return Array.from({ length: 17 }, function() { return { value: 0, pressed: false }; });
}

const actuator = {
  playEffect: function(type, effect) {
    rumbleCalls.push({ type, effect });
    return Promise.resolve();
  },
  reset: function() { rumbleCalls.push({ type: 'reset' }); return Promise.resolve(); }
};
const pad = {
  index: 1,
  id: 'Sony DualSense Wireless Controller',
  connected: true,
  timestamp: 1,
  axes: [0, 0, 0, 0],
  buttons: makeButtons(),
  vibrationActuator: actuator
};
let pads = [null, pad];

const memory = new SharedArrayBuffer(8192);
const heap32 = new Int32Array(memory);
const snapshotPtr = 64;
const rumblePtr = 4096;
const stateWords = 7 + 8 + 17 + 17;
const payloadWords = 1 + 4 * stateWords;

const context = {
  console: { log: function() {}, warn: function() {}, error: function() {} },
  navigator: { getGamepads: function() { return pads; } },
  performance: { now: function() { return now; } },
  Module: {
    HEAP32: heap32,
    _gamepadSnapshotAddress: function() { return snapshotPtr; },
    _gamepadSnapshotMaxPads: function() { return 4; },
    _gamepadSnapshotButtonCount: function() { return 17; },
    _gamepadSnapshotStride: function() { return stateWords * 4; },
    _gamepadSnapshotWordCount: function() { return payloadWords; },
    _rumbleStateAddress: function() { return rumblePtr; },
    _notifyGamepadSnapshot: function() { notifications++; },
    _resetRumbleState: function() {
      for (let i = 0; i < 4; i++) { Atomics.store(heap32, (rumblePtr >> 2) + i, 0); }
    }
  },
  CustomEvent: function() {},
  Int32Array,
  Float32Array,
  ArrayBuffer,
  Atomics,
  Set,
  Promise,
  Math,
  Number,
  Date,
  isFinite,
  window: null
};
context.window = context;
context.addEventListener = function(name, callback) {
  (listeners[name] || (listeners[name] = [])).push(callback);
};
context.dispatchEvent = function() {};
context.requestAnimationFrame = function(callback) { rafCallback = callback; return 1; };
context.cancelAnimationFrame = function() { rafCallback = null; };
context.setTimeout = function(callback) { timerCallback = callback; return 1; };
context.clearTimeout = function() { timerCallback = null; };

vm.createContext(context);
vm.runInContext(fs.readFileSync('wasm/platform/gamepad.js', 'utf8'), context);

// A physical index hole is compacted to logical controller zero.
assert.strictEqual(context.getStreamingGamepadMask(), 1);
context.startGamepadSnapshot(true);
assert(rafCallback);
rafCallback();
assert.strictEqual(notifications, 1);
const base = snapshotPtr >> 2;
assert.strictEqual(Atomics.load(heap32, base) & 1, 0);
assert.strictEqual(Atomics.load(heap32, base + 1), 4);
assert.strictEqual(Atomics.load(heap32, base + 2), 1);
assert.strictEqual(Atomics.load(heap32, base + 2 + 4), 2); // PlayStation type

// An unchanged frame performs no shared publication and no worker wakeup.
rafCallback();
assert.strictEqual(notifications, 1);

pad.buttons[0] = { value: 1, pressed: true };
pad.timestamp++;
rafCallback();
assert.strictEqual(notifications, 2);

// Physical haptics run after rAF and host bursts coalesce at a 10 Hz ceiling.
const rumbleBase = rumblePtr >> 2;
Atomics.store(heap32, rumbleBase, (0x7000 << 16) | 0x3000);
rafCallback();
assert.strictEqual(rumbleCalls.length, 0);
assert(timerCallback);
let pendingTimer = timerCallback;
timerCallback = null;
pendingTimer();
assert.strictEqual(rumbleCalls.length, 1);
assert.strictEqual(rumbleCalls[0].type, 'dual-rumble');

now = 20;
Atomics.store(heap32, rumbleBase, (0x4000 << 16) | 0x2000);
rafCallback();
assert.strictEqual(timerCallback, null);
now = 120;
rafCallback();
assert(timerCallback);
pendingTimer = timerCallback;
timerCallback = null;
pendingTimer();
assert.strictEqual(rumbleCalls.length, 2);

// If the platform retains preempted Promises, calls are bounded rather than
// accumulating forever. The latest state remains pending and the watchdog
// eventually lets it through without disturbing the input animation frame.
now = 220;
Atomics.store(heap32, rumbleBase, (0x3000 << 16) | 0x1000);
rafCallback();
assert(timerCallback);
pendingTimer = timerCallback;
timerCallback = null;
pendingTimer();
assert.strictEqual(rumbleCalls.length, 2);

now = 900;
rafCallback();
assert(timerCallback);
pendingTimer = timerCallback;
timerCallback = null;
pendingTimer();
assert.strictEqual(rumbleCalls.length, 3);

// Zero always preempts, even while an actuator operation is outstanding.
now = 910;
Atomics.store(heap32, rumbleBase, 0);
rafCallback();
assert(timerCallback);
pendingTimer = timerCallback;
timerCallback = null;
pendingTimer();
assert.strictEqual(rumbleCalls[3].type, 'reset');

context.stopGamepadSnapshot();
assert.strictEqual(Atomics.load(heap32, base + 1), 0);

// With haptics disabled at the protocol boundary, the animation frame does not
// even scan the rumble mailboxes or schedule a post-frame task.
const callsBeforeDisabledRun = rumbleCalls.length;
context.startGamepadSnapshot(false);
Atomics.store(heap32, rumbleBase, (0x7000 << 16) | 0x3000);
rafCallback();
assert.strictEqual(timerCallback, null);
assert.strictEqual(rumbleCalls.length, callsBeforeDisabledRun);
context.stopGamepadSnapshot();
console.log('gamepad_snapshot_test: ok');
