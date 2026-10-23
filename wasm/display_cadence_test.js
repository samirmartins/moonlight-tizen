'use strict';
// Synthetic rAF timing only; this does not measure a physical panel.
const assert = require('assert'), fs = require('fs'), cp = require('child_process'), vm = require('vm');
const file = 'wasm/platform/display.js';
const old = cp.execFileSync('git', ['show', 'v3.4.9:' + file], {encoding: 'utf8'});
const current = fs.readFileSync(file, 'utf8');
function setup(source) {
  const c = {console: {log() {}}, Math, Date, isFinite}; c.window = c;
  c.requestAnimationFrame = () => 1; c.cancelAnimationFrame = () => {};
  vm.createContext(c); vm.runInContext(source, c); return c;
}
function feed(c, values) {
  c._displayRefreshSamples = values; c._displayFinishRefreshEstimate();
  assert.strictEqual(c._displayRefreshRaf, 0, 'estimator stops before gameplay');
  return c.getDisplayRefreshRateX100(60);
}
for (const hz of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120]) {
  const values = Array.from({length: 240}, (_, i) => 1000 / hz + (i % 5 - 2) * 0.08);
  const a = setup(old), b = setup(current);
  assert.strictEqual(feed(b, values), feed(a, values), 'reliable estimate preserved at ' + hz);
  assert.strictEqual(b._displayRefreshRawHz, a._displayRefreshRawHz);
}
const mixed = Array.from({length: 240}, (_, i) => 1000 / (i % 2 ? 30 : 60));
assert.strictEqual(feed(setup(old), mixed), 4000, 'old defect reproduced');
assert.strictEqual(feed(setup(current), mixed), 6000, 'unstable cadence uses configured FPS fallback');
const trusted = setup(current);
assert.strictEqual(feed(trusted, Array(240).fill(1000 / 59.94)), 5994);
assert.strictEqual(feed(trusted, mixed), 5994, 'rejecting noise preserves last reliable result');
assert.strictEqual(trusted._mlDisplayRefreshX100, 5994);
assert.strictEqual(feed(setup(current), Array(29).fill(1000 / 60)), 6000);
assert.strictEqual(feed(setup(current), Array(30).fill(NaN)), 6000);
assert.strictEqual(feed(setup(current), Array(240).fill(Infinity)), 6000);
const sparseOutliers = Array.from({length: 240}, (_, i) => i < 12 ? 33.33 : 1000 / 60);
assert.strictEqual(feed(setup(current), sparseOutliers), feed(setup(old), sparseOutliers), 'existing trimmed-outlier behavior preserved');
assert.strictEqual(current.slice(current.indexOf('function setDisplayStreamReference(')),
  old.slice(old.indexOf('function setDisplayStreamReference(')), 'presentation/telemetry code untouched');
// Removing the gate must fail the same behavioral assertion.
const mutated = current.replace('deviationMs > meanMs * 0.05', 'false');
assert.notStrictEqual(mutated, current);
assert.throws(() => assert.strictEqual(feed(setup(mutated), mixed), 6000));
console.log('display_cadence_test: 11 stable rates preserved; mixed 60/30 callbacks 40Hz -> FPS fallback; last good estimate retained; negative control PASS');
