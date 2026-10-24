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
  source = require('./video-transport-scope.cjs').normalize(file, source);
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
  const scoped = files.concat('wasm/platform/gamepad.js');
  const publication = require('./gamepad-publication-scope.cjs').normalize;
  for (const file of paths.filter(file => scoped.includes(file))) {
    const old = cp.execFileSync('git', ['show', reference+':'+file], {encoding:'utf8'});
    assert.strictEqual(publication(file, normalize(file, fs.readFileSync(file,'utf8'))),
      publication(file, normalize(file, old)), file+' approved telemetry/publication changes only');
  }
  const rest = paths.filter(file => !scoped.includes(file));
  if (rest.length) {
    // Git pathspecs may include all native sources. Permit only the exact,
    // independently tested overlay aggregation move, never a whole-file mask.
    const changed = cp.execFileSync('git', ['diff', '--name-only', reference, '--', ...rest], {encoding:'utf8'}).trim().split('\n').filter(Boolean);
    for (const file of changed) {
      if (file === 'wasm/static/css/vibelight.css') {
        assert.strictEqual(require('./branding-scope.cjs').normalize(file, fs.readFileSync(file, 'utf8')), '', 'exact geometry-free branding skin only');
        continue;
      }
      if (file === 'moonlight-common-c/src/VideoRecoveryLog.h') {
        assert.strictEqual(require('./video-transport-scope.cjs').normalize(file, fs.readFileSync(file, 'utf8')), '', 'exact tested log helper only');
        continue;
      }
      // The wildcard above also matches this test-only adapter. The frozen
      // CMake source list must keep it out of the application target.
      if (file === 'wasm/video_recovery_fixture.cpp') {
        assert(!fs.readFileSync('CMakeLists.txt', 'utf8').includes(file), 'recovery fixture is not linked into the app');
        continue;
      }
      const wording = require('./warning-text-scope.cjs');
      if (wording.files.includes(file)) {
        const old = cp.execFileSync('git', ['show', reference+':'+file], {encoding:'utf8'});
        assert.strictEqual(wording.normalize(file, fs.readFileSync(file,'utf8')), old,
          'approved warning literals only: '+file);
        continue;
      }
      const recovery = require('./video-recovery-scope.cjs');
      if (recovery.files.includes(file) && file !== 'wasm/wasmplayer.cpp') {
        const old = cp.execFileSync('git', ['show', reference+':'+file], {encoding:'utf8'});
        assert.strictEqual(recovery.normalize(file, fs.readFileSync(file,'utf8')), old,
          'exact tested recovery patch only: '+file);
        continue;
      }
      if (file === 'wasm/platform/index.js') {
        const old = cp.execFileSync('git', ['show', reference+':'+file], {encoding:'utf8'});
        const defaults = require('./rumble-default-scope.cjs').normalize;
        assert.strictEqual(defaults(file, fs.readFileSync(file,'utf8')), defaults(file, old), 'rumble default only');
        continue;
      }
      if (file === 'wasm/static/css/controller-mapping.css') {
        const old = cp.execFileSync('git', ['show', reference+':'+file], {encoding:'utf8'});
        const visual = require('./controller-test-scope.cjs').normalize;
        assert.strictEqual(visual(file, fs.readFileSync(file,'utf8')), visual(file, old), 'controller test styles only');
        continue;
      }
      if (file === 'wasm/index.html') {
        const old=cp.execFileSync('git',['show',reference+':'+file],{encoding:'utf8'});
        const menu=require('./manual-library-scope.cjs').normalize;
        assert.strictEqual(menu(file,fs.readFileSync(file,'utf8')),menu(file,old),'approved menu labels only');
        continue;
      }
      if (file === 'wasm/platform/navigation.js') {
        const old=cp.execFileSync('git',['show',reference+':'+file],{encoding:'utf8'});
        const menu=require('./library-navigation-scope.cjs').normalize;
        assert.strictEqual(menu(file,fs.readFileSync(file,'utf8')),menu(file,old),'exact menu transition hooks only');
        continue;
      }
      if (file === 'wasm/main.cpp') {
        const old = cp.execFileSync('git', ['show', reference+':'+file], {encoding:'utf8'});
        assert.strictEqual(require('./branding-scope.cjs').normalize(file, fs.readFileSync(file,'utf8')), old, 'only the two approved visible product-name literals may differ');
        continue;
      }
      // Permit only the approved packaging version bump; IDs, build options
      // and every other byte remain part of the frozen contract.
      if (file === 'CMakeLists.txt' || file === 'res/config.xml') {
        const old = cp.execFileSync('git', ['show', reference+':'+file], {encoding:'utf8'});
        const current = require('./branding-scope.cjs').normalize(file, fs.readFileSync(file, 'utf8'));
        const normalizeVersion = source => file === 'CMakeLists.txt'
          ? source.replace('project(MoonlightWasm VERSION 3.4.10)', 'project(MoonlightWasm VERSION 3.4.3)')
            .replace('project(MoonlightWasm VERSION 3.4.9)', 'project(MoonlightWasm VERSION 3.4.3)')
            .replace('project(MoonlightWasm VERSION 3.4.8)', 'project(MoonlightWasm VERSION 3.4.3)')
            .replace('project(MoonlightWasm VERSION 3.4.7)', 'project(MoonlightWasm VERSION 3.4.3)')
            .replace('project(MoonlightWasm VERSION 3.4.6)', 'project(MoonlightWasm VERSION 3.4.3)')
            .replace('project(MoonlightWasm VERSION 3.4.5)', 'project(MoonlightWasm VERSION 3.4.3)')
            .replace('project(MoonlightWasm VERSION 3.4.4)', 'project(MoonlightWasm VERSION 3.4.3)')
          : source.replace(' version="3.4.10"', ' version="3.4.3"').replace(' version="3.4.9"', ' version="3.4.3"').replace(' version="3.4.8"', ' version="3.4.3"').replace(' version="3.4.7"', ' version="3.4.3"').replace(' version="3.4.6"', ' version="3.4.3"').replace(' version="3.4.5"', ' version="3.4.3"').replace(' version="3.4.4"', ' version="3.4.3"');
        assert.strictEqual(normalizeVersion(current), normalizeVersion(old), 'approved version bump only');
        continue;
      }
      assert.strictEqual(file, 'wasm/wasmplayer.cpp', 'unrelated inputs unchanged');
      const old = cp.execFileSync('git', ['show', reference+':'+file], {encoding:'utf8'});
      const overlay = require('./overlay-aggregation-scope.cjs').normalize;
      assert.strictEqual(overlay(file, fs.readFileSync(file,'utf8')), overlay(file, old), 'overlay aggregation move only');
    }
  }
}
module.exports = {normalize, assertFrozen, files};
