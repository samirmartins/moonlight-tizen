'use strict';
// Source-only guards. No signing input, network request or widget mutation.
const fs = require('fs'), assert = require('assert'), cp = require('child_process');
const directory = '.github/workflows';
function permitsPrivateSigning(source) {
  return /tizen[-_]author|AUTHOR_P12|pkcs12|tizen\s+package|secret-files:/i.test(source);
}
for (const name of fs.readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
  assert(!permitsPrivateSigning(fs.readFileSync(directory + '/' + name, 'utf8')), name);
}
assert(permitsPrivateSigning('secret-files: tizen_author=fixture'));
assert(permitsPrivateSigning('AUTHOR_P12_BASE64: fixture'));
const ci = fs.readFileSync(directory + '/ci.yml', 'utf8');
assert.match(ci, /contents: read/);
assert.match(ci, /bash build-tools\/run-tests\.sh/);
assert.doesNotMatch(ci, /contents: write/);
for (const extension of ['p12', 'pfx', 'key', 'jks', 'keystore']) {
  assert.match(fs.readFileSync('.gitignore', 'utf8'), new RegExp('^\\*\\.' + extension + '$', 'm'));
  assert.strictEqual(cp.spawnSync('git', ['check-ignore', '--no-index', 'fixture.' + extension], {stdio:'pipe'}).status, 0);
}
console.log('release_security_test: remote private signing absent, read-only CI and ignored key stores OK');
