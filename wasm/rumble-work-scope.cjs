'use strict';
// Reverse only the tested inactive-slot skip; all actuator policy stays frozen.
function normalize(file,source) {
  source=require('./controller-vendor-scope.cjs').normalize(file,source);
  if(file !== 'wasm/platform/gamepad.js')return source;
  const begin=source.indexOf('function _rumbleNeedsPump(now) {');
  const end=source.indexOf('function _rumbleStop() {',begin);
  require('assert')(begin>=0 && end>begin);
  const block=source.slice(begin,end)
    .replaceAll('    var pad = _gpLogicalPads && _gpLogicalPads[slot];\n    if (!pad) { continue; }\n','')
    .replaceAll('_gpGetActuator(pad)','_gpGetActuator(_gpLogicalPads && _gpLogicalPads[slot])');
  return source.slice(0,begin)+block+source.slice(end);
}
module.exports={normalize};
