// Standard gamepad permutation. No menu, polling, timers or DOM work on load.
var ControllerMapping = (function() {
  var key = 'moonlight.controller-mapping.v1';
  var editable = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];
  var session = null;
  function defaults() {
    return { version: 1, enabled: false, map: Array.from({length:17}, function(_,i) { return i; }) };
  }
  function valid(config) {
    if (!config || config.version !== 1 || typeof config.enabled !== 'boolean' ||
        !Array.isArray(config.map) || config.map.length !== 17 || config.map[16] !== 16) return false;
    var seen = new Set();
    for (var i = 0; i < 17; i++) {
      var target = config.map[i];
      if (!Number.isInteger(target) || target < 0 || target >= 17 || seen.has(target)) return false;
      // Never reduce an analog trigger to a digital button, or vice versa.
      if ((i === 6 || i === 7) !== (target === 6 || target === 7)) return false;
      seen.add(target);
    }
    return true;
  }
  function copy(config) { return {version:1, enabled:config.enabled, map:config.map.slice()}; }
  var saved = defaults();
  try {
    var parsed = JSON.parse(localStorage.getItem(key));
    if (valid(parsed)) saved = copy(parsed);
  } catch (e) {} // Corrupt/unavailable storage means the original controls.
  function save(config) {
    if ((typeof isInGame !== 'undefined' && isInGame) || !valid(config)) return false;
    try { localStorage.setItem(key, JSON.stringify(copy(config))); } catch (e) { return false; }
    saved = copy(config);
    return true;
  }
  function assign(config, source, target) {
    if (!valid(config) || editable.indexOf(source) < 0 || editable.indexOf(target) < 0 ||
        (source === 6 || source === 7) !== (target === 6 || target === 7)) return false;
    var other = config.map.indexOf(target), previous = config.map[source];
    config.map[source] = target;
    config.map[other] = previous;
    return true;
  }
  function prepareSession() {
    session = saved.enabled ? copy(saved) : null;
    return session !== null;
  }
  function sessionBuilder(legacy) {
    // Selected once, before the rAF loop. OFF returns the original function,
    // not a wrapper/branch executed for every sample.
    if (!session || _gpButtonCount !== 17) return legacy;
    var sources = [], targets = [];
    for (var i = 0; i < 17; i++) {
      if (session.map[i] !== i) { sources.push(i); targets.push(session.map[i]); }
    }
    if (!sources.length) return legacy;
    var scratch = new Int32Array(sources.length * 2);
    var requiredButtons = Math.max.apply(null, targets) + 1;
    return function(pads) {
      legacy(pads);
      var words = _gpNextWords, stride = _gpStride >> 2;
      for (var slot = 0; slot < _gpMaxPads; slot++) {
        var offset = 1 + slot * stride;
        if (!words[offset]) continue;
        var analog = offset + 7 + _GP_MAX_AXES, digital = analog + _gpButtonCount;
        // Keep the existing physical disconnect/overlay shortcuts reachable.
        if (words[digital+8] && words[digital+4] && words[digital+5]) {
          var mask = 0;
          for (var b = 0; b < 17; b++) if (b !== 6 && b !== 7 && words[digital+b]) mask |= 1 << b;
          if (mask === ((1<<8)|(1<<9)|(1<<4)|(1<<5)) ||
              mask === ((1<<8)|(1<<4)|(1<<5)|(1<<2))) continue;
        }
        // Snapshot words preserve the exact float bits, including trigger range.
        // Read all changed sources before writing any destination (swap cycles).
        for (var j = 0; j < sources.length; j++) {
          scratch[j*2] = words[analog+sources[j]];
          scratch[j*2+1] = words[digital+sources[j]];
        }
        for (var k = 0; k < targets.length; k++) {
          words[analog+targets[k]] = scratch[k*2];
          words[digital+targets[k]] = scratch[k*2+1];
        }
        words[offset+2] = Math.max(words[offset+2], requiredButtons);
      }
    };
  }
  return { defaults:defaults, valid:valid, get:function() { return copy(saved); },
    save:save, assign:assign, prepareSession:prepareSession, sessionBuilder:sessionBuilder };
})();
