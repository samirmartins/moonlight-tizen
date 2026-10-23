// Shared menu-only directional input. The streaming publisher never uses this state.
var LibraryNavigation = (function() {
  var pads = Object.create(null), owner = null, direction = null, timer = null, epoch = 0, pendingAction = false;
  var activate = 0.5, release = 0.35, initialDelay = 350, repeatInterval = 100;

  function available() {
    return !isInGame && !document.hidden &&
      (typeof Navigation.isRunning !== 'function' || Navigation.isRunning());
  }
  function cancelRepeat() {
    ++epoch;
    clearTimeout(timer); timer = null; direction = null; owner = null;
  }
  function reset() { cancelRepeat(); pads = Object.create(null); pendingAction = false; }
  function viewChanged() {
    // Retain held directions as suppressed until release or a new direction.
    // A stick held at a view boundary must not immediately move its new menu.
    cancelRepeat(); pendingAction = false;
  }
  function disconnect(index) {
    delete pads[index];
    if (owner === index) cancelRepeat();
  }
  function axis(value, previous) {
    if (value > activate) return 1;
    if (value < -activate) return -1;
    return Math.abs(value) > release && value * previous > 0 ? previous : 0;
  }
  function choose(pad, current) {
    var x = Number(!!pad.buttons[15]) - Number(!!pad.buttons[14]);
    var y = Number(!!pad.buttons[13]) - Number(!!pad.buttons[12]);
    var digital = pad.buttons[12] || pad.buttons[13] || pad.buttons[14] || pad.buttons[15];
    if (!digital) { x = pad.x; y = pad.y; }
    var horizontal = x < 0 ? 'left' : x > 0 ? 'right' : null;
    var vertical = y < 0 ? 'up' : y > 0 ? 'down' : null;
    if (horizontal && vertical) {
      // Keep a stable axis near a diagonal, rather than alternating on noise.
      if (digital) return current === vertical ? vertical : horizontal;
      if (current === horizontal && Math.abs(pad.axes[1]) <= Math.abs(pad.axes[0]) + 0.15) return horizontal;
      if (current === vertical && Math.abs(pad.axes[0]) <= Math.abs(pad.axes[1]) + 0.15) return vertical;
      return Math.abs(pad.axes[0]) >= Math.abs(pad.axes[1]) ? horizontal : vertical;
    }
    return horizontal || vertical;
  }
  function schedule(delay, token) {
    timer = setTimeout(function() {
      if (token !== epoch) return;
      timer = null;
      if (!available()) { reset(); return; }
      Navigation[direction]();
      if (token === epoch && available()) schedule(repeatInterval, token);
      else if (token === epoch) reset();
    }, delay);
  }
  function handle(detail) {
    if (!available()) { reset(); return false; }
    var index = detail.padIndex === undefined ? 0 : detail.padIndex;
    var pad = pads[index];
    if (!pad) pad = pads[index] = {buttons: Object.create(null), axes: [0, 0], x: 0, y: 0};
    var action = null;
    // Resolve the complete poll before choosing a direction: release order is
    // not meaningful when left and right change together.
    detail.changes.forEach(function(change) {
      if (change.type === 'button') {
        if (change.index >= 12 && change.index <= 15) pad.buttons[change.index] = !!change.pressed;
        if (change.pressed) {
          if (change.index === 0) action = 'accept';
          else if (change.index === 1) action = 'back';
          else if (change.index === 8 || change.index === 3) action = 'press';
        }
      } else if (change.type === 'axis' && (change.index === 0 || change.index === 1)) {
        pad.axes[change.index] = Number.isFinite(change.value) ? change.value : 0;
      }
    });
    pad.x = axis(pad.axes[0], pad.x); pad.y = axis(pad.axes[1], pad.y);
    var previous = pad.direction || null;
    var next = choose(pad, previous);
    pad.direction = next;
    if (action) {
      viewChanged();
      var actionToken = epoch;
      pendingAction = true;
      // Keep the existing confirm/back debounce; only directions are immediate.
      delayedNavigation(function() {
        if (actionToken !== epoch) return;
        if (!available()) { reset(); return; }
        pendingAction = false; Navigation[action]();
      });
      return true;
    }
    if (pendingAction) return true;
    // A different pad's unchanged held direction/noise must not steal focus.
    if (owner !== index && (!next || next === previous)) return true;
    if (owner === index && next === direction) return true;
    cancelRepeat();
    if (!next) return true;
    owner = index; direction = next;
    var token = epoch;
    Navigation[direction]();
    if (token === epoch && available()) schedule(initialDelay, token);
    else if (token === epoch) reset();
    return true;
  }
  return {handle: handle, reset: reset, disconnect: disconnect, viewChanged: viewChanged};
})();
