'use strict';
// Reverse only the approved display literals/assets for historical contracts.
// Unknown executable changes remain visible; branding_test freezes the result
// against the latest published runtime, independently of the older contracts.
function asset(file, data) {
  const hashes = {'wasm/static/favicon/favicon.png': '5c08a469de0c4ebf01522a9ea073f3aab01d59dbcf0c4e991b7573f30f599ef3'};
  if (!hashes[file] || require('crypto').createHash('sha256').update(data).digest('hex') !== hashes[file]) return data;
  return require('child_process').execFileSync('git', ['show', 'v3.4.10:' + file]);
}
function normalize(file, source) {
  if (file === 'wasm/static/css/vibelight.css' && require('crypto').createHash('sha256').update(source).digest('hex') === 'aaa6bfdf3abd12115c07f8b7d8cc9c09173219c790b6417de6664a2dc4b4d637') return '';
  if (file === 'wasm/static/favicon/favicon.png') {
    const current = require('fs').readFileSync(file);
    if (source === current.toString('utf8')) return asset(file, current).toString('utf8');
  }
  if (file === 'wasm/platform/index.js') return source
    .replace(".text('Loading VibeLight...')", ".text('Loading Moonlight...')")
    .replace('Are you sure you want to restart VibeLight?', 'Are you sure you want to restart Moonlight?');
  if (file === 'wasm/platform/console-library.js') return source
    .replaceAll('Reload VibeLight.', 'Reload Moonlight.')
    .replace('then reload VibeLight.', 'then reload Moonlight.');
  if (file === 'wasm/index.html') return source
    .replace('  <link rel="stylesheet" href="static/css/vibelight.css">\n', '')
    .replace('<img src="static/res/vibelight-mark.png" id="header-logo" alt="">', '<img src="static/res/ic_moonlight_logo.svg" id="header-logo">')
    .replace('<img src="static/res/vibelight-logo.png" id="wasmSpinnerLogo" alt="VibeLight Tizen">', '<img src="static/res/ic_moonlight_logo.svg" id="wasmSpinnerLogo">')
    .replaceAll('VibeLight', 'Moonlight');
  if (file === 'CMakeLists.txt') return source.replace('project(MoonlightWasm VERSION 3.4.11)', 'project(MoonlightWasm VERSION 3.4.10)');
  if (file === 'res/config.xml') return source
    .replace('version="3.4.11"', 'version="3.4.10"')
    .replace('<name>VibeLight</name>', '<name>Moonlight</name>')
    .replace('<description>VibeLight Game Streaming</description>', '<description>Moonlight Game Streaming</description>');
  return source;
}
module.exports = {normalize, asset};
