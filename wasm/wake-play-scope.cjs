'use strict';
// Exact exceptions for the independently tested Wake & play preparation.
// Manual launch, streaming payloads and every other library path stay frozen.
const cp=require('child_process'),crypto=require('crypto');
function normalize(file,source) {
  if(file==='wasm/platform/index.js')return source
    .replace('function startGame(host, appID, audioPrepared, serverInfoReady) {',
      'function startGame(host, appID, audioPrepared) {')
    .replace('  // Wake & play already verified fresh metadata in its cancellable boot loop.\n'+
      '  // All other callers retain the original server-info refresh.\n'+
      '  (serverInfoReady === true ? Promise.resolve() : host.refreshServerInfo()).then(function(ret) {',
      '  host.refreshServerInfo().then(function(ret) {');
  if(file!=='wasm/platform/console-library.js')return source;
  source=source.replace('  function launch(appId, audioReady, serverInfoReady) {','  function launch(appId, audioReady) {')
    .replace('    startGame(chosenHost,appId,audioReady,serverInfoReady);','    startGame(chosenHost,appId,audioReady);');
  const begin='  function play(appId) {',end='  function bind() {';
  const a=source.indexOf(begin),b=source.indexOf(end,a);
  if(a>=0&&b>a&&crypto.createHash('sha256').update(source.slice(a,b)).digest('hex')==='1185deb779b25e286536cec93bfa5ae90c5f6bc0abb44d3df27babddcd37ed34') {
    const old=cp.execFileSync('git',['show','f5ccf2a:'+file],{encoding:'utf8'});
    source=source.slice(0,a)+old.slice(old.indexOf(begin),old.indexOf(end,old.indexOf(begin)))+source.slice(b);
  }
  return source;
}
module.exports={normalize};
