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

  var tick = function() {
    _gpPublish();
    _gpRafHandle = window.requestAnimationFrame(tick);
  };
  _gpRafHandle = window.requestAnimationFrame(tick);
  console.log('%c[gamepad.js, startGamepadSnapshot]', 'color: green;',
    'Publishing gamepad state on animation frames.');
}

function stopGamepadSnapshot() {
  if (_gpRafHandle !== 0) {
    window.cancelAnimationFrame(_gpRafHandle);
    _gpRafHandle = 0;
  }
  // Leave the pad count at zero so the worker stops acting on stale state
  if (_gpSnapshotPtr !== 0) {
    Module.HEAP32[_gpSnapshotPtr >> 2] = 0;
  }
}

function _gpPublish() {
  if (_gpSnapshotPtr === 0) {
    return;
  }

  var pads = navigator.getGamepads ? navigator.getGamepads() : [];
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
