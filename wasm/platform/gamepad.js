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
      this.axes = gamepad.axes.slice(); // Store initial axis values
    }

    analyzeButtonsAndAxes(newButtons, newAxes) {
      if (this.buttons.length !== newButtons.length || this.axes.length !== newAxes.length) {
        console.error('%c[gamepad.js, analyzeButtonsAndAxes]', 'color: gray;', 'Error: New buttons or axes layout does not match the saved one!');
        return;
      }

      const changes = [];

      for (let i = 0; i < newButtons.length; ++i) {
        if (this.buttons[i].pressed !== newButtons[i].pressed) {
          changes.push({
            type: 'button',
            index: i,
            pressed: newButtons[i].pressed,
          });
        }
      }

      for (let i = 0; i < newAxes.length; i++) {
        if (this.axes[i] !== newAxes[i]) {
          changes.push({
            type: 'axis',
            index: i,
            value: newAxes[i]
          });
        }
      }

      if (changes.length > 0) {
        window.dispatchEvent(new CustomEvent('gamepadinputchanged', {
            detail: { changes },
          })
        );
      }

      this.buttons = newButtons.map((button) => new Button(button));
      this.axes = newAxes.slice(); // Update stored axis values
    }
  }

  function gamepadConnected(gamepad) {
    gamepads[gamepad.index] = new Gamepad(gamepad);
  }

  function gamepadDisconnected(gamepad) {
    delete gamepads[gamepad.index];
  }

  // Named so that repeated startWatching() calls re-register the same function
  // reference, which addEventListener deduplicates. Anonymous handlers would
  // accumulate a new copy on every start/stop cycle.
  function onGamepadConnected(e) {
    gamepadConnected(e.gamepad);
  }

  function onGamepadDisconnected(e) {
    gamepadDisconnected(e.gamepad);
  }

  function analyzeGamepad(gamepad) {
    const index = gamepad.index;
    const pGamepad = gamepads[index];

    if (pGamepad) {
      pGamepad.analyzeButtonsAndAxes(gamepad.buttons, gamepad.axes);
    }
  }

  function pollGamepads() {
    const gamepads = navigator.getGamepads
      ? navigator.getGamepads()
      : navigator.webkitGetGamepads
      ? navigator.webkitGetGamepads
      : [];
    for (const gamepad of gamepads) {
      if (gamepad) {
        analyzeGamepad(gamepad);
      }
    }
  }

  // This polling exists to drive UI navigation only. During streaming the pads
  // are read by the native input thread instead, and this must be stopped:
  // it runs on the main thread, which is the same thread that services the
  // media element, so leaving it on costs video frames.
  function startWatching() {
    if (!pollingInterval) {
      window.addEventListener('gamepadconnected', onGamepadConnected);
      window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
      // 60 Hz is plenty for menu navigation. The previous 5 ms interval ran 200
      // times a second and allocated a Button object per button on each pass.
      pollingInterval = setInterval(pollGamepads, 16);
    }
  }

  function stopWatching() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  return {
    startWatching,
    stopWatching 
  };
})();

// Publishes gamepad state into the WASM heap on every animation frame.
//
// The input worker in wasm/gamepad.cpp used to ask Emscripten for gamepad state
// directly. All three of those functions are proxied synchronously to this
// thread, because navigator.getGamepads() only exists here, so a 5 ms poll on
// the worker turned into six hundred blocking round trips a second onto the same
// thread that schedules audio and drives the media pipeline.
//
// Reading here and writing to shared memory removes every one of them. The
// worker reads plain memory, and requestAnimationFrame gives us the display's
// cadence, which is the rate at which fresher input could actually matter.
//
// The layout written below must match struct GamepadSnapshot in
// wasm/gamepad.cpp. Both sides derive the variable parts from the exported
// gamepadSnapshotMaxPads(), gamepadSnapshotButtonCount() and
// gamepadSnapshotStride(), so only the field order is duplicated knowledge, and
// static assertions on the C++ side fail the build if the layout gains padding.
var _gpSnapshotPtr = 0;
var _gpMaxPads = 0;
var _gpButtonCount = 0;
var _gpRafHandle = 0;
var _gpStride = 0;

function startGamepadSnapshot() {
  if (_gpRafHandle !== 0) {
    return; // already running
  }
  try {
    _gpSnapshotPtr = Module._gamepadSnapshotAddress();
    _gpMaxPads = Module._gamepadSnapshotMaxPads();
    _gpButtonCount = Module._gamepadSnapshotButtonCount();
    _gpStride = Module._gamepadSnapshotStride();
  } catch (e) {
    console.error('%c[gamepad.js, startGamepadSnapshot]', 'color: red;',
      'Could not resolve the gamepad snapshot; input will not work.', e);
    return;
  }

  // Resolved apart from the block above on purpose: input is the critical path,
  // and a rumble that cannot be resolved must cost input nothing.
  try {
    _rumblePtr = Module._rumbleStateAddress();
  } catch (e) {
    _rumblePtr = 0;
    console.warn('%c[gamepad.js, startGamepadSnapshot]', 'color: orange;',
      'Rumble unavailable; input is unaffected.', e);
  }

  // One gamepad list per frame, serving both consumers. Fetching it is not free,
  // and there is no reason for the snapshot and the rumble to fetch it twice.
  var tick = function(now) {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    _gpPublish(pads);
    _rumbleApply(pads, now);
    _gpRafHandle = window.requestAnimationFrame(tick);
  };
  _gpRafHandle = window.requestAnimationFrame(tick);
  console.log('%c[gamepad.js, startGamepadSnapshot]', 'color: green;',
    'Publishing gamepad state on animation frames.');
}

function stopGamepadSnapshot() {
  _rumbleStop();
  if (_gpRafHandle !== 0) {
    window.cancelAnimationFrame(_gpRafHandle);
    _gpRafHandle = 0;
  }
  // Leave the pad count at zero so the worker stops acting on stale state
  if (_gpSnapshotPtr !== 0) {
    Module.HEAP32[_gpSnapshotPtr >> 2] = 0;
  }
}

function _gpPublish(pads) {
  if (_gpSnapshotPtr === 0 || !pads) {
    return;
  }

  var count = pads.length < _gpMaxPads ? pads.length : _gpMaxPads;

  var h32 = Module.HEAP32;
  var hf32 = Module.HEAPF32;
  var base = _gpSnapshotPtr;

  h32[base >> 2] = count;

  // First pad starts after the leading numGamepads int32
  var padBase = base + 4;

  for (var p = 0; p < count; p++) {
    var gp = pads[p];
    var o = (padBase + p * _gpStride) >> 2;

    if (!gp) {
      h32[o] = 0; // connected
      continue;
    }

    var numAxes = gp.axes ? gp.axes.length : 0;
    var numButtons = gp.buttons ? gp.buttons.length : 0;
    if (numAxes > 8) { numAxes = 8; }
    if (numButtons > _gpButtonCount) { numButtons = _gpButtonCount; }

    h32[o] = gp.connected ? 1 : 0;
    h32[o + 1] = numAxes;
    h32[o + 2] = numButtons;
    h32[o + 3] = gp.timestamp ? 1 : 0;

    var axisBase = o + 4;
    for (var a = 0; a < numAxes; a++) {
      hf32[axisBase + a] = gp.axes[a];
    }

    var analogBase = axisBase + 8;
    var digitalBase = analogBase + _gpButtonCount;
    for (var b = 0; b < numButtons; b++) {
      var btn = gp.buttons[b];
      // A button is either an object with .value and .pressed, or a bare number
      // on older implementations
      if (typeof btn === 'object' && btn !== null) {
        hf32[analogBase + b] = btn.value;
        h32[digitalBase + b] = btn.pressed ? 1 : 0;
      } else {
        hf32[analogBase + b] = btn;
        h32[digitalBase + b] = btn > 0.5 ? 1 : 0;
      }
    }
  }
}

// ─── Rumble ──────────────────────────────────────────────────────────────────
//
// The host sends rumble continuously during action. Applying each event the
// moment it arrives meant a synchronous thread crossing, a gamepad lookup and a
// console line per event, all on the thread that also schedules audio, and it
// showed up as uneven video: the feature had to be switched off to get a smooth
// picture.
//
// Events now only deposit their magnitudes here. The effect is applied from the
// animation frame callback above, at most once per frame per pad, reusing the
// gamepad list it has already fetched. A vibration cannot be felt changing more
// often than that, so nothing is lost by holding an event for a few
// milliseconds, and a burst of twenty events between two frames costs one call
// instead of twenty.
var _RUMBLE_MAX_PADS = 4;

// How long one call asks the pad to run for, and how long a held magnitude is
// allowed to go before the call is made again.
//
// A held magnitude produces no new calls - the value has not changed, so there
// is nothing to send - and the effect used to be given a five second duration to
// cover that. Two things were wrong with it. A vibration held longer than five
// seconds died while the host was still asking for it, because nothing renewed
// it. And if the platform queues effects rather than superseding them, five
// seconds of overlap is thirty of them alive at once, for a session's length.
//
// A short duration with an explicit renewal fixes both. The renewal is well
// inside the duration so a continuous vibration never gaps, and at most two
// calls a second are outstanding for a pad that is being held steady.
var _RUMBLE_DURATION_MS = 1000;
var _RUMBLE_RENEW_MS = 700;

// Last renewal per pad, and whether that pad is currently meant to be silent.
// A silent pad is not renewed: there is nothing to keep alive.
var _rumbleRenewedAt = new Float64Array(_RUMBLE_MAX_PADS);

// Shared, so claiming a promise does not allocate a pair of closures on every
// call. At tens of calls a second for a session measured in hours, allocation
// that could be hoisted should be.
function _rumbleNoop() {}

// Address of the magnitude words wasm/gamepad.cpp writes, one per pad, resolved
// when the loop starts.
var _rumblePtr = 0;

// Last word acted on, per pad, so a magnitude that has not moved does not
// produce a call. Games hold a steady vibration for long stretches.
var _rumbleLastApplied = new Int32Array(_RUMBLE_MAX_PADS);

// Floor on the interval between calls into the pad, per pad.
//
// A dual-rumble pad drives weighted motors whose spin-up and spin-down are
// measured in tens of milliseconds; they cannot express a magnitude that moves
// at frame rate, so calling at frame rate asks the TV to do work whose result
// nobody can feel. Thirty times a second is already past what the hardware
// reproduces, and it halves the one cost left on this path that is not ours.
//
// This is a floor on the interval, not a delay: the first change after a quiet
// spell is applied on the very next frame, so an impulse - a shot, an impact -
// is never held back. Only a sustained stream of changes gets thinned.
var _RUMBLE_MIN_INTERVAL_MS = 50;
var _rumbleNextAllowed = new Float64Array(_RUMBLE_MAX_PADS);

// Swallows the promise the haptics calls return, when they return one at all.
// Implementations that predate the promise-returning form give back undefined,
// so the shape is checked rather than assumed.
function _rumbleClaim(p) {
  if (p && typeof p.then === 'function') {
    p.then(_rumbleNoop, _rumbleNoop);
  }
}

// Reads the magnitudes the host asked for and hands them to the pads.
//
// Nothing is pushed here from C++; the word is simply read once per frame from
// the animation frame callback, which is already walking the gamepad list. That
// is what keeps the rumble off the main thread entirely: the rate at which the
// host sends events is not ours to control, but the rate at which we act on
// them is one per frame per pad, and a vibration cannot be felt changing faster
// than that.
//
// Each word packs both magnitudes, written by a single aligned store, so the
// pair read here is always the pair that was written - never a new low against
// an old high.
function _rumbleApply(pads, now) {
  if (_rumblePtr === 0 || !pads) {
    return;
  }
  var count = pads.length < _RUMBLE_MAX_PADS ? pads.length : _RUMBLE_MAX_PADS;
  var base = _rumblePtr >> 2;
  for (var i = 0; i < count; i++) {
    var packed = Module.HEAP32[base + i];

    // A magnitude that has not changed still has to be renewed before the
    // effect it started runs out, or a vibration the host is still asking for
    // stops on its own. A pad meant to be silent is left alone.
    if (packed === _rumbleLastApplied[i]) {
      if (packed === 0 || (now - _rumbleRenewedAt[i]) < _RUMBLE_RENEW_MS) {
        continue;
      }
    }
    // Held back, not dropped. The word is left unclaimed, so the next frame
    // compares against it again and applies whatever the newest value is by
    // then - which is what a pad should be given, rather than a stale one that
    // had been queued behind it.
    if (now < _rumbleNextAllowed[i]) {
      continue;
    }
    _rumbleLastApplied[i] = packed;
    _rumbleNextAllowed[i] = now + _RUMBLE_MIN_INTERVAL_MS;
    _rumbleRenewedAt[i] = now;

    var gp = pads[i];
    if (!gp || !gp.vibrationActuator) {
      continue;
    }
    try {
      // The returned promise has to be claimed. A try/catch does not cover it -
      // it only covers a synchronous throw - so a pad that disconnects mid
      // effect, or an actuator that refuses, would leave an unhandled rejection
      // behind. Chromium reports each of those to the console, which is work on
      // the very thread this whole path exists to keep clear.
      _rumbleClaim(gp.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: _RUMBLE_DURATION_MS,
        weakMagnitude: (packed & 0xffff) / 65535,
        strongMagnitude: ((packed >>> 16) & 0xffff) / 65535
      }));
    } catch (e) {
      // A pad that refuses the effect is not worth a line per event
    }
  }
}

// Silences every pad and forgets the last magnitudes. Without this, a stream
// that ends mid-vibration leaves the controller buzzing until the effect's own
// duration runs out.
function _rumbleStop() {
  _rumbleLastApplied.fill(0);
  _rumbleNextAllowed.fill(0);
  _rumbleRenewedAt.fill(0);
  var pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (var i = 0; i < pads.length && i < _RUMBLE_MAX_PADS; i++) {
    var gp = pads[i];
    if (!gp || !gp.vibrationActuator) {
      continue;
    }
    try { _rumbleClaim(gp.vibrationActuator.reset()); } catch (e) {}
  }
  try {
    if (typeof Module !== 'undefined' && Module._resetRumbleState) {
      Module._resetRumbleState();
    }
  } catch (e) {}
}
