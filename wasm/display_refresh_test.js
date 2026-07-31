'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let callback = null;
const context = {
  console: { log: function() {} },
  Date,
  Math,
  isFinite,
  window: null
};
context.window = context;
context.requestAnimationFrame = function(cb) { callback = cb; return 1; };
context.cancelAnimationFrame = function() { callback = null; };
vm.createContext(context);
vm.runInContext(fs.readFileSync('wasm/platform/display.js', 'utf8'), context);

context.startDisplayRefreshEstimator();
let timestamp = 100;
for (let i = 0; i < 245 && callback; i++) {
  const current = callback;
  timestamp += (i === 80 ? 100 : 1000 / 59.94); // one rejected suspension outlier
  current(timestamp);
}
assert.strictEqual(context.getDisplayRefreshRateX100(60), 5994);
assert.strictEqual(context.window._mlDisplayRefreshX100, 5994);
console.log('display_refresh_test: ok');
