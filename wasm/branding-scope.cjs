'use strict';
// Reverse only the approved display literals/assets for historical contracts.
// Unknown executable changes remain visible; branding_test freezes the result
// against the latest published runtime, independently of the older contracts.
function asset(file, data) {
  const hashes = {'wasm/static/favicon/favicon.png': 'fd5c936608fab9c15857924836251999b5a8f3deda7c79a1a2ffaf124160b0b9'};
  if (!hashes[file] || require('crypto').createHash('sha256').update(data).digest('hex') !== hashes[file]) return data;
  return require('child_process').execFileSync('git', ['show', 'v3.4.10:' + file]);
}
function normalize(file, source) {
  if (file === 'wasm/static/css/vibelight.css' && require('crypto').createHash('sha256').update(source).digest('hex') === '0459fa6b0d0d4f3b72014ff7f6245a7064809846c04f368b0146427ea08c286c') return '';
  if (file === 'wasm/static/favicon/favicon.png') {
    const current = require('fs').readFileSync(file);
    if (source === current.toString('utf8')) return asset(file, current).toString('utf8');
  }
  if (file === 'wasm/platform/index.js') return source
    .replaceAll("$('#main-header').css({'backgroundColor': '', 'boxShadow': ''});", "$('#main-header').css({'backgroundColor': '#333846', 'boxShadow': 'none'});")
    .replace("$('body').css('backgroundColor', '');", "$('body').css('backgroundColor', '#282C38');")
    .replace(".text('Loading VibeLight...')", ".text('Loading Moonlight...')")
    .replace('Are you sure you want to restart VibeLight?', 'Are you sure you want to restart Moonlight?');
  if (file === 'wasm/platform/messages.js') return source.replace("$('body').css('backgroundColor', '');", "$('body').css('backgroundColor', '#282C38');");
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
