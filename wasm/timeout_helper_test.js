'use strict';

const assert = require('assert');
const { withTimeout } = require('./static/js/utils.js');

(async function() {
  let timeoutCalls = 0;
  const value = await withTimeout(
    Promise.resolve('ok'), 10, 'should not fire', () => timeoutCalls++);
  assert.strictEqual(value, 'ok');

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.strictEqual(timeoutCalls, 0);

  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, 'expected timeout', () => timeoutCalls++),
    /expected timeout/);
  assert.strictEqual(timeoutCalls, 1);

  console.log('timeout_helper_test: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
