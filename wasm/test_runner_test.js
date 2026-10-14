'use strict';
const cp = require('child_process'), assert = require('assert');
function run(code, timeout = 3000) {
  return cp.spawnSync(process.execPath, ['--unhandled-rejections=strict', '--require', './build-tools/test-process.cjs', '-e', code],
    {encoding: 'utf8', timeout, env: {...process.env, ML_TEST_NAME: 'fixture'}});
}
assert.strictEqual(run("console.log('fixture: complete')").status, 0);
assert.notStrictEqual(run("(async()=>{await new Promise(()=>{});console.log('fixture: complete')})()").status, 0);
assert.notStrictEqual(run("process.exit(0)").status, 0);
assert.notStrictEqual(run("Promise.reject(Error('fixture failure'))").status, 0);
const stuck = run('setInterval(()=>{},10)', 100);
assert(stuck.error && stuck.error.code === 'ETIMEDOUT');
console.log('test_runner_test: completion, unfinished promises, early exit, rejection and timeout OK');
