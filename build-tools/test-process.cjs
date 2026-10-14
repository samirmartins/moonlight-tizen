'use strict';
// Loaded only by the development test runner; never by the widget.
const fs = require('fs');
const name = process.env.ML_TEST_NAME;
if (!name) throw Error('Missing explicit test name');
const original = fs.mkdtempSync, temporary = new Set();
fs.mkdtempSync = function(...args) {
  const directory = original.apply(this, args);
  temporary.add(directory);
  return directory;
};
let completed = false;
const log = console.log;
console.log = function(...args) {
  if (typeof args[0] === 'string' && args[0].startsWith(name + ':')) completed = true;
  return log.apply(this, args);
};
process.on('exit', code => {
  for (const directory of temporary) fs.rmSync(directory, {recursive: true, force: true});
  if (code === 0 && !completed) {
    process.stderr.write('Test exited without its completion marker: ' + name + '\n');
    process.exitCode = 1;
  }
});
