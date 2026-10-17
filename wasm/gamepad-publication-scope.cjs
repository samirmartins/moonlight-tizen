'use strict';
// Normalize only the changed-word store loop. Detection, atomics, sequence,
// last-state copy and notification must still match the historical publisher.
function normalize(file, source) {
  source = require('./rumble-work-scope.cjs').normalize(file, source);
  source = require('./controller-menu-scope.cjs').normalize(file, source);
  if (file !== 'wasm/platform/gamepad.js') return source;
  return source.replace(
    '  if (i === 0) {\n'+
    '    // Initial publication and stop still overwrite the complete payload.\n'+
    '    for (var word = 0; word < _gpWordCount; word++) {\n'+
    '      Atomics.store(heap, base + 1 + word, _gpNextWords[word]);\n'+
    '    }\n'+
    '  } else {\n'+
    '    // The odd sequence protects changed fields exactly as a full publication.\n'+
    '    for (var word = i; word < _gpWordCount; word++) {\n'+
    '      if (_gpNextWords[word] !== _gpLastWords[word]) {\n'+
    '        Atomics.store(heap, base + 1 + word, _gpNextWords[word]);\n'+
    '      }\n'+
    '    }\n'+
    '  }',
    '  for (var word = 0; word < _gpWordCount; word++) {\n'+
    '    Atomics.store(heap, base + 1 + word, _gpNextWords[word]);\n'+
    '  }');
}
module.exports = {normalize};
