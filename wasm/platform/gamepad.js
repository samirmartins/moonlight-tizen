const Controller = (function() {
  let pollingInterval = null;
  const gamepads = {};

  class Button {
    constructor(button) {
      this.value = button.value;
      this.pressed = button.pressed;
    }
  }

  class Gamepad {
    constructor(gamepad) {
      this.buttons = gamepad.buttons.map((button) => new Button(button));
      this.axes = gamepad.axes.slice();
    }

    analyzeButtonsAndAxes(newButtons, newAxes) {
      if (this.buttons.length !== newButtons.length || this.axes.length !== newAxes.length) {
        return;
      }
      const changes = [];
      for (let i = 0; i < newButtons.length; ++i) {
        if (this.buttons[i].pressed !== newButtons[i].pressed) {
          changes.push({ type: 'button', index: i, pressed: newButtons[i].pressed });
        }
      }
      for (let i = 0; i < newAxes.length; i++) {
        if (this.axes[i] !== newAxes[i]) {
          changes.push({ type: 'axis', index: i, value: newAxes[i] });
        }
      }
      if (changes.length) {
        window.dispatchEvent(new CustomEvent('gamepadinputchanged', { detail: { changes } }));
      }
      this.buttons = newButtons.map((button) => new Button(button));
      this.axes = newAxes.slice();
    }
  }

  function onGamepadConnected(event) {
    gamepads[event.gamepad.index] = new Gamepad(event.gamepad);
  }

  function onGamepadDisconnected(event) {
    delete gamepads[event.gamepad.index];
  }

  function pollGamepads() {
    var pads = navigator.getGamepads ? navigator.getGamepads() :
      (navigator.webkitGetGamepads ? navigator.webkitGetGamepads() : []);
    for (var i = 0; i < pads.length; i++) {
      var pad = pads[i];
      if (pad && gamepads[pad.index]) {
        gamepads[pad.index].analyzeButtonsAndAxes(pad.buttons, pad.axes);
      }
    }
  }

  function startWatching() {
    if (!pollingInterval) {
      window.addEventListener('gamepadconnected', onGamepadConnected);
      window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
      pollingInterval = setInterval(pollGamepads, 16);
    }
  }

  function stopWatching() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  return { startWatching: startWatching, stopWatching: stopWatching };
})();

// Streaming gamepad publisher. navigator.getGamepads() is main-thread-only on
// Emscripten, so one rAF sample is converted into a coherent shared-memory
// snapshot. The native input worker is notified only when that state changes.
var _GP_MAX_AXES = 8;
var _GP_DEFAULT_MAX_PADS = 4;
var _GP_TYPE_UNKNOWN = 0;
var _GP_TYPE_XBOX = 1;
var _GP_TYPE_PS = 2;
var _GP_TYPE_NINTENDO = 3;
var _GP_CAP_ANALOG_TRIGGERS = 1;
var _GP_CAP_RUMBLE = 2;
var _GP_STANDARD_BUTTON_FLAGS = 0xffff;

var _gpSnapshotPtr = 0;
var _gpMaxPads = 0;
var _gpButtonCount = 0;
var _gpStride = 0;
var _gpWordCount = 0;
var _gpRafHandle = 0;
var _gpNextWords = null;
var _gpNextFloats = null;
var _gpLastWords = null;
var _gpPhysicalForSlot = null;
var _gpLogicalPads = null;
var _gpTypeForSlot = null;
var _gpCapabilitiesForSlot = null;
var _gpKnownPhysical = new Set();

function _gpEnsureMappings(maxPads) {
  if (_gpPhysicalForSlot && _gpPhysicalForSlot.length === maxPads &&
      _gpTypeForSlot && _gpCapabilitiesForSlot) {
    return;
  }
  _gpPhysicalForSlot = new Int32Array(maxPads);
  _gpPhysicalForSlot.fill(-1);
  _gpLogicalPads = new Array(maxPads);
  _gpTypeForSlot = new Int32Array(maxPads);
  _gpCapabilitiesForSlot = new Int32Array(maxPads);
}

function _gpClearSlotMetadata(slot) {
  _gpTypeForSlot[slot] = _GP_TYPE_UNKNOWN;
  _gpCapabilitiesForSlot[slot] = 0;
}

function _gpCacheSlotMetadata(slot, gamepad) {
  var buttons = gamepad && gamepad.buttons ? gamepad.buttons : [];
  _gpTypeForSlot[slot] = _gpControllerType(gamepad);
  _gpCapabilitiesForSlot[slot] =
    (buttons.length > 7 ? _GP_CAP_ANALOG_TRIGGERS : 0) |
    (_gpGetActuator(gamepad) ? _GP_CAP_RUMBLE : 0);
}

function _gpGetActuator(gamepad) {
  if (!gamepad) { return null; }
  if (gamepad.vibrationActuator) { return gamepad.vibrationActuator; }
  if (gamepad.hapticActuators && gamepad.hapticActuators.length) {
    return gamepad.hapticActuators[0];
  }
  return null;
}

function _gpControllerType(gamepad) {
  var id = gamepad && gamepad.id ? gamepad.id.toLowerCase() : '';
  if (/playstation|dualsense|dualshock|sony/.test(id)) { return _GP_TYPE_PS; }
  if (/xbox|xinput|x-box|microsoft|360/.test(id)) { return _GP_TYPE_XBOX; }
  if (/nintendo|switch|joy-con|pro controller/.test(id)) { return _GP_TYPE_NINTENDO; }
  return _GP_TYPE_UNKNOWN;
}

function _gpIsUsable(gamepad) {
  if (!gamepad || !gamepad.connected) { return false; }
  if (gamepad.timestamp) { _gpKnownPhysical.add(gamepad.index); }
  return !!gamepad.timestamp || _gpKnownPhysical.has(gamepad.index);
}

function _gpFindSlot(physicalIndex) {
  if (!_gpPhysicalForSlot) { return -1; }
  for (var slot = 0; slot < _gpPhysicalForSlot.length; slot++) {
    if (_gpPhysicalForSlot[slot] === physicalIndex) { return slot; }
  }
  return -1;
}

function _gpRefreshMappings(pads, maxPads) {
  _gpEnsureMappings(maxPads);
  for (var slot = 0; slot < maxPads; slot++) {
    var physical = _gpPhysicalForSlot[slot];
    var existing = physical >= 0 ? pads[physical] : null;
    if (physical >= 0 && !_gpIsUsable(existing)) {
      _gpPhysicalForSlot[slot] = -1;
      _gpLogicalPads[slot] = null;
      _gpClearSlotMetadata(slot);
      _rumbleForgetSlot(slot);
    }
  }
  for (var p = 0; p < pads.length; p++) {
    var gamepad = pads[p];
    if (!_gpIsUsable(gamepad) || _gpFindSlot(gamepad.index) >= 0) { continue; }
    for (var freeSlot = 0; freeSlot < maxPads; freeSlot++) {
      if (_gpPhysicalForSlot[freeSlot] < 0) {
        _gpPhysicalForSlot[freeSlot] = gamepad.index;
        _gpCacheSlotMetadata(freeSlot, gamepad);
        _rumbleForgetSlot(freeSlot);
        break;
      }
    }
  }
  for (var logical = 0; logical < maxPads; logical++) {
    var physicalIndex = _gpPhysicalForSlot[logical];
    _gpLogicalPads[logical] = physicalIndex >= 0 ? pads[physicalIndex] : null;
  }
}

window.addEventListener('gamepadconnected', function(event) {
  _gpKnownPhysical.add(event.gamepad.index);
});
window.addEventListener('gamepaddisconnected', function(event) {
  _gpKnownPhysical.delete(event.gamepad.index);
  var slot = _gpFindSlot(event.gamepad.index);
  if (slot >= 0) {
    _gpPhysicalForSlot[slot] = -1;
    _gpLogicalPads[slot] = null;
    _gpClearSlotMetadata(slot);
    _rumbleForgetSlot(slot);
  }
});

// Used before launch as well as during streaming, so host and client agree on
// the same stable logical controller numbers even when browser indexes have gaps.
function getStreamingGamepadMask() {
  var pads = navigator.getGamepads ? navigator.getGamepads() : [];
  var maxPads = _gpMaxPads || _GP_DEFAULT_MAX_PADS;
  _gpRefreshMappings(pads, maxPads);
  var mask = 0;
  for (var slot = 0; slot < maxPads; slot++) {
    if (_gpLogicalPads[slot]) { mask |= 1 << slot; }
  }
  return mask;
}

function _gpBuildSnapshot(pads) {
  _gpRefreshMappings(pads, _gpMaxPads);
  _gpNextWords.fill(0);
  _gpNextWords[0] = _gpMaxPads;
  var strideWords = _gpStride >> 2;
  for (var slot = 0; slot < _gpMaxPads; slot++) {
    var gamepad = _gpLogicalPads[slot];
    if (!gamepad) { continue; }
    var offset = 1 + slot * strideWords;
    var axes = gamepad.axes || [];
    var buttons = gamepad.buttons || [];
    var numAxes = Math.min(_GP_MAX_AXES, axes.length);
    var numButtons = Math.min(_gpButtonCount, buttons.length);
    _gpNextWords[offset] = 1;
    _gpNextWords[offset + 1] = numAxes;
    _gpNextWords[offset + 2] = numButtons;
    _gpNextWords[offset + 3] = gamepad.timestamp ? 1 : 0;
    // Type detection lowercases the controller name and runs several regular
    // expressions. Capabilities also inspect the actuator object. Both are
    // immutable for a connected pad, so they are cached when its slot is made
    // rather than rebuilt on every animation frame.
    _gpNextWords[offset + 4] = _gpTypeForSlot[slot];
    _gpNextWords[offset + 5] = _gpCapabilitiesForSlot[slot];
    _gpNextWords[offset + 6] = _GP_STANDARD_BUTTON_FLAGS;
    var axisBase = offset + 7;
    for (var axis = 0; axis < numAxes; axis++) {
      var axisValue = Number(axes[axis]);
      _gpNextFloats[axisBase + axis] = isFinite(axisValue) ? axisValue : 0;
    }
    var analogBase = axisBase + _GP_MAX_AXES;
    var digitalBase = analogBase + _gpButtonCount;
    for (var button = 0; button < numButtons; button++) {
      var value = buttons[button];
      if (typeof value === 'object' && value !== null) {
        var analog = Number(value.value);
        _gpNextFloats[analogBase + button] = isFinite(analog) ? analog : 0;
        _gpNextWords[digitalBase + button] = value.pressed ? 1 : 0;
      } else {
        var numeric = Number(value);
        _gpNextFloats[analogBase + button] = isFinite(numeric) ? numeric : 0;
        _gpNextWords[digitalBase + button] = numeric > 0.5 ? 1 : 0;
      }
    }
  }
}

function _gpPublishIfChanged() {
  var changed = false;
  for (var i = 0; i < _gpWordCount; i++) {
    if (_gpNextWords[i] !== _gpLastWords[i]) { changed = true; break; }
  }
  if (!changed) { return; }
  var heap = Module.HEAP32;
  var base = _gpSnapshotPtr >> 2;
  Atomics.add(heap, base, 1);
  for (var word = 0; word < _gpWordCount; word++) {
    Atomics.store(heap, base + 1 + word, _gpNextWords[word]);
  }
  Atomics.add(heap, base, 1);
  _gpLastWords.set(_gpNextWords);
  try { Module._notifyGamepadSnapshot(); } catch (e) {}
}

var _rumbleEnabled = false;

function startGamepadSnapshot(rumbleEnabled) {
  if (_gpRafHandle) { return; }
  try {
    _gpSnapshotPtr = Module._gamepadSnapshotAddress();
    _gpMaxPads = Module._gamepadSnapshotMaxPads();
    _gpButtonCount = Module._gamepadSnapshotButtonCount();
    _gpStride = Module._gamepadSnapshotStride();
    _gpWordCount = Module._gamepadSnapshotWordCount();
    _rumbleEnabled = !!rumbleEnabled;
    _rumblePtr = _rumbleEnabled ? Module._rumbleStateAddress() : 0;
  } catch (e) {
    console.error('%c[gamepad.js]', 'color: red;', 'Unable to initialize input snapshot.', e);
    return;
  }
  _gpEnsureMappings(_gpMaxPads);
  var nextBuffer = new ArrayBuffer(_gpWordCount * 4);
  _gpNextWords = new Int32Array(nextBuffer);
  _gpNextFloats = new Float32Array(nextBuffer);
  _gpLastWords = new Int32Array(_gpWordCount);
  _gpLastWords.fill(0x7fffffff);

  var tick = function() {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    _gpBuildSnapshot(pads);
    _gpPublishIfChanged();
    if (_rumbleEnabled) { _rumbleMaybeSchedule(); }
    _gpRafHandle = window.requestAnimationFrame(tick);
  };
  _gpRafHandle = window.requestAnimationFrame(tick);
}

function stopGamepadSnapshot() {
  _rumbleStop();
  _rumbleEnabled = false;
  _rumblePtr = 0;
  if (_gpRafHandle) {
    window.cancelAnimationFrame(_gpRafHandle);
    _gpRafHandle = 0;
  }
  if (_gpNextWords && _gpSnapshotPtr) {
    _gpNextWords.fill(0);
    _gpPublishIfChanged();
  }
}

// Rumble is sampled cheaply in rAF but physically applied from a post-frame
// task. Host bursts collapse into their latest atomic state, calls are bounded
// to 10 Hz for changing effects, and held effects renew before expiry.
var _RUMBLE_MAX_PADS = 4;
var _RUMBLE_DURATION_MS = 500;
var _RUMBLE_RENEW_MS = 400;
var _RUMBLE_MIN_INTERVAL_MS = 100;
var _RUMBLE_MAX_IN_FLIGHT = 2;
var _RUMBLE_WATCHDOG_MS = 750;
var _rumblePtr = 0;
var _rumbleTask = 0;
var _rumbleLastApplied = new Int32Array(_RUMBLE_MAX_PADS);
var _rumbleRenewedAt = new Float64Array(_RUMBLE_MAX_PADS);
var _rumbleNextAllowed = new Float64Array(_RUMBLE_MAX_PADS);
var _rumbleInFlight = new Uint8Array(_RUMBLE_MAX_PADS);
var _rumbleInFlightSince = new Float64Array(_RUMBLE_MAX_PADS);
var _rumbleGeneration = new Uint32Array(_RUMBLE_MAX_PADS);

function _rumbleInvalidateInflight(slot) {
  _rumbleGeneration[slot]++;
  _rumbleInFlight[slot] = 0;
  _rumbleInFlightSince[slot] = 0;
}

function _rumbleClaim(result, slot, now) {
  if (result && typeof result.then === 'function') {
    var generation = _rumbleGeneration[slot];
    if (_rumbleInFlight[slot] === 0) {
      _rumbleInFlightSince[slot] = now;
    }
    _rumbleInFlight[slot]++;
    var settled = function() {
      if (_rumbleGeneration[slot] !== generation) { return; }
      if (_rumbleInFlight[slot] > 0) { _rumbleInFlight[slot]--; }
      if (_rumbleInFlight[slot] === 0) { _rumbleInFlightSince[slot] = 0; }
    };
    result.then(settled, settled);
  }
}

function _rumbleCanStart(slot, now) {
  if (_rumbleInFlight[slot] < _RUMBLE_MAX_IN_FLIGHT) { return true; }
  if (now - _rumbleInFlightSince[slot] >= _RUMBLE_WATCHDOG_MS) {
    // The platform failed to settle preempted effects. Forget the stale logical
    // claims and allow the newest state through; late settlements are ignored
    // by the generation check above.
    _rumbleInvalidateInflight(slot);
    return true;
  }
  return false;
}

function _rumbleNow() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function _rumbleForgetSlot(slot) {
  if (slot < 0 || slot >= _RUMBLE_MAX_PADS) { return; }
  _rumbleLastApplied[slot] = 0;
  _rumbleRenewedAt[slot] = 0;
  _rumbleNextAllowed[slot] = 0;
  _rumbleInvalidateInflight(slot);
}

function _rumbleNeedsPump(now) {
  if (!_rumblePtr) { return false; }
  var heap = Module.HEAP32;
  var base = _rumblePtr >> 2;
  for (var slot = 0; slot < _RUMBLE_MAX_PADS; slot++) {
    var packed = Atomics.load(heap, base + slot);
    if (packed !== _rumbleLastApplied[slot]) {
      if (packed === 0 || now >= _rumbleNextAllowed[slot]) { return true; }
    } else if (packed !== 0 && now - _rumbleRenewedAt[slot] >= _RUMBLE_RENEW_MS) {
      return true;
    }
  }
  return false;
}

function _rumbleMaybeSchedule() {
  if (_rumbleTask || !_rumbleNeedsPump(_rumbleNow())) { return; }
  _rumbleTask = window.setTimeout(function() {
    _rumbleTask = 0;
    _rumblePump();
  }, 0);
}

function _rumblePump() {
  if (!_rumblePtr) { return; }
  var now = _rumbleNow();
  var heap = Module.HEAP32;
  var base = _rumblePtr >> 2;
  for (var slot = 0; slot < _RUMBLE_MAX_PADS; slot++) {
    var packed = Atomics.load(heap, base + slot);
    var renewing = packed === _rumbleLastApplied[slot] && packed !== 0 &&
      now - _rumbleRenewedAt[slot] >= _RUMBLE_RENEW_MS;
    var changed = packed !== _rumbleLastApplied[slot];
    if (!changed && !renewing) { continue; }
    if (packed !== 0 && now < _rumbleNextAllowed[slot]) { continue; }

    var actuator = _gpGetActuator(_gpLogicalPads && _gpLogicalPads[slot]);
    if (packed !== 0 && !_rumbleCanStart(slot, now)) {
      // Keep the state pending and retry no faster than the existing 10 Hz
      // limit. Normal actuators never enter this branch.
      _rumbleNextAllowed[slot] = now + _RUMBLE_MIN_INTERVAL_MS;
      continue;
    }
    _rumbleLastApplied[slot] = packed;
    _rumbleRenewedAt[slot] = now;
    _rumbleNextAllowed[slot] = packed === 0 ? 0 : now + _RUMBLE_MIN_INTERVAL_MS;
    if (!actuator) { continue; }
    try {
      if (packed === 0) {
        // Stop is never held behind a slow effect. Invalidate old logical
        // claims before issuing reset so their late Promises cannot affect it.
        _rumbleInvalidateInflight(slot);
        if (typeof actuator.reset === 'function') {
          _rumbleClaim(actuator.reset(), slot, now);
        } else if (typeof actuator.pulse === 'function') {
          _rumbleClaim(actuator.pulse(0, 0), slot, now);
        }
      } else {
        var weak = (packed & 0xffff) / 65535;
        var strong = ((packed >>> 16) & 0xffff) / 65535;
        if (typeof actuator.playEffect === 'function') {
          _rumbleClaim(actuator.playEffect('dual-rumble', {
            startDelay: 0,
            duration: _RUMBLE_DURATION_MS,
            weakMagnitude: weak,
            strongMagnitude: strong
          }), slot, now);
        } else if (typeof actuator.pulse === 'function') {
          _rumbleClaim(
            actuator.pulse(Math.max(weak, strong), _RUMBLE_DURATION_MS), slot, now);
        }
      }
    } catch (e) {}
  }
}

function _rumbleStop() {
  if (_rumbleTask) {
    window.clearTimeout(_rumbleTask);
    _rumbleTask = 0;
  }
  if (_gpLogicalPads) {
    for (var slot = 0; slot < _gpLogicalPads.length; slot++) {
      var actuator = _gpGetActuator(_gpLogicalPads[slot]);
      if (!actuator) { continue; }
      try {
        _rumbleInvalidateInflight(slot);
        if (typeof actuator.reset === 'function') {
          _rumbleClaim(actuator.reset(), slot, _rumbleNow());
        } else if (typeof actuator.pulse === 'function') {
          _rumbleClaim(actuator.pulse(0, 0), slot, _rumbleNow());
        }
      } catch (e) {}
    }
  }
  _rumbleLastApplied.fill(0);
  _rumbleRenewedAt.fill(0);
  _rumbleNextAllowed.fill(0);
  _rumbleInFlight.fill(0);
  _rumbleInFlightSince.fill(0);
  for (var generationSlot = 0;
       generationSlot < _RUMBLE_MAX_PADS; generationSlot++) {
    _rumbleGeneration[generationSlot]++;
  }
  try {
    if (Module._resetRumbleState) { Module._resetRumbleState(); }
  } catch (e) {}
}
