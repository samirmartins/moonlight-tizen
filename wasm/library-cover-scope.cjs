'use strict';
// Normalize the separately tested selection path before cover-only exceptions.
// The independent cover tests exercise the excluded implementation directly.
const assert = require('assert');
function normalize(file, source) {
  source = require('./library-selection-scope.cjs').normalize(file, source);
  if (file === 'wasm/static/js/utils.js') return source.replace(
    "        if (typeof ConsoleLibrary !== 'undefined') ConsoleLibrary.invalidateCovers(this);\n", '');
  if (file !== 'wasm/platform/console-library.js') return source;
  const begin = '  // Menu cover reuse:', end = '  // End menu cover reuse.\n';
  if (source.includes(begin)) {
    const first = source.indexOf(begin), last = source.indexOf(end, first);
    assert(last > first && source.indexOf(begin, first + 1) === -1);
    source = source.slice(0, first) + source.slice(last + end.length);
  }
  source = source.replace('    invalidateCovers: invalidateCovers,\n', '');
  const first = source.indexOf('  function render(forceCovers) {');
  const last = source.indexOf('  function connect(current, token) {', first);
  assert(first >= 0 && last > first);
  return source.slice(0, first) + '  [menu cover render tested separately]\n' + source.slice(last);
}
module.exports = { normalize };
