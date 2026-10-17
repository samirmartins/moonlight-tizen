'use strict';
// Only the approved optional-statistics gates are normalized. PCM, drift,
// jitter targets, observer algorithms and all other lifecycle code stay frozen.
const assert = require('assert'), fs = require('fs'), cp = require('child_process');
const files = ['wasm/platform/audio.js','wasm/platform/audio-worklet.js',
  'wasm/platform/display.js','wasm/platform/diagnostics.js'];
function removeBlock(source, begin, end) {
  if (!source.includes(begin)) return source;
  const first = source.indexOf(begin), last = source.indexOf(end, first);
  assert(first >= 0 && last > first && source.indexOf(begin, first+1) === -1);
  return source.slice(0, first) + source.slice(last + end.length);
}
function normalize(file, source) {
  if (file === 'wasm/platform/audio.js') {
    source = removeBlock(source, '\n// Optional audio collection is switched', '// End optional audio collection switch.\n');
    source = source.replace('      generation: _audGeneration,\n      telemetry: _audTelemetryMask !== 0', '      generation: _audGeneration');
    source = source.replace('function _audCollectFallbackDepth(depth)', 'function _audNoteFallbackDepth(depth)');
    const first = source.indexOf('function publishPipelinePosition(positionMs) {');
    const last = source.indexOf('// Called synchronously from the user gesture', first);
    assert(first >= 0 && last > first);
    return source.slice(0, first) + source.slice(first, last).replace(/^  _audRefreshStats\(\);\n/gm, '') + source.slice(last);
  }
  if (file === 'wasm/platform/audio-worklet.js') {
    source = source.replace('    this.noteDepth = this.ignoreDepth;\n', '')
      .replace('        this.setTelemetry(data.telemetry);\n', '');
    source = source.replace("      // Collection changes arrive only on explicit consumer transitions.\n" +
      "      if (data.type === 'telemetry') {\n" +
      '        if (this.ready && data.generation === this.generation) this.setTelemetry(data.enabled);\n' +
      '        return;\n      }\n', '');
    return removeBlock(source, '  // Optional depth collection changes', '  // End optional depth collection switch.\n\n');
  }
  if (file === 'wasm/platform/display.js' || file === 'wasm/platform/diagnostics.js') {
    const indent = file.endsWith('/display.js') ? '  ' : '    ';
    const consumer = file.endsWith('/display.js') ? 'overlay' : 'diagnostics';
    for (const enabled of ['true','false']) source = source.replace(indent+
      "if (typeof setAudioTelemetryEnabled === 'function') setAudioTelemetryEnabled('"+consumer+"', "+enabled+");\n", '');
    return source;
  }
  return source;
}
function assertFrozen(reference, paths) {
  for (const file of paths.filter(file => files.includes(file))) {
    const old = cp.execFileSync('git', ['show', reference+':'+file], {encoding:'utf8'});
    assert.strictEqual(normalize(file, fs.readFileSync(file,'utf8')), normalize(file, old), file+' optional telemetry only');
  }
  const rest = paths.filter(file => !files.includes(file));
  if (rest.length) assert.strictEqual(cp.execFileSync('git', ['diff', reference, '--', ...rest], {encoding:'utf8'}), '', 'unrelated inputs unchanged');
}
module.exports = {normalize, assertFrozen, files};
