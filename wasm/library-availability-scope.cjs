'use strict';
// Exact, independently tested menu availability exceptions. Never hide edits
// to launch, WoL, pairing, HTTP transport, input, audio or video algorithms.
const cp=require('child_process'),crypto=require('crypto'),assert=require('assert');
const sections={
  'wasm/platform/console-library.js':[
    ['  function render(', '  function connect(', '69aafb83a791d8e5052ca5ce4dd60001981ecdc73f2776b36dc28d437b0246d2'],
    ['  function refresh(', '  function focusCards(', '04255ac26805bd17d4a22bafda7b8d56511be7cada257f54c2078b71b7875cc1'],
    ['  function open(pc)', '  function ready(', '6f2919a468f45a162ecaf7bb421d864d34c5f34059de204c908b27b31f444dfe']
  ],
  'wasm/static/js/utils.js':[
    ['  refreshServerInfoScoped:', '  connect:', '476672b39b90f7c7ccd3081ab7b371d55a9d7447f233ee85b824431d08974887'],
    ['  selectServerAddress:', '  toString:', 'dbf2725732255a18a3797acb5e98a224e1c1a3c9399c59f155d0e12a29522976'],
    ['  _parseServerInfo:', '  getAppById:', '95787058e23368c329f9c5641cbc172c122e2c7fd28dae7cfefd5cd26f5fa390'],
    ['  // App-list availability:', '  getAppListWithCacheFlush:', '16f91142457d110e6d190fca304b89cd20ad5e4df26d44fe2a6dda168d32050b'],
    ['  getAppListWithCacheFlush:', '  getAppList:', '270bc7d8a2d47592650d54483c7c0b1b11cebc4949897acc79b4b956276163f9']
  ]
};
function normalize(file,source) {
  if(file==='wasm/platform/menu-tools.js')return source.replace('    scope.useAppListProbe = true;\n','');
  if(!sections[file])return source;
  const old=cp.execFileSync('git',['show','v3.4.5:'+file],{encoding:'utf8'});
  for(const [begin,end,hash] of sections[file]) {
    const a=source.indexOf(begin),b=source.indexOf(end,a);
    if(a<0 && begin==='  // App-list availability:')continue;
    assert(a>=0&&b>a,'bounded availability section');
    if(crypto.createHash('sha256').update(source.slice(a,b)).digest('hex')!==hash)continue;
    const x=old.indexOf(begin),y=old.indexOf(end,x);
    source=source.slice(0,a)+(x<0?'':old.slice(x,y))+source.slice(b);
  }
  if(file==='wasm/platform/console-library.js')source=source
    .replace('    current.useAppListProbe = true;\n','')
    .replace('  var refreshPending = null, refreshCovers = false;\n','')
    .replace('    refreshPending = null; refreshCovers = false;\n','')
    .replace('    // Checking never locks Play/Wake. Repeated Refresh shares the current work.',
      '    // A background check is never a lock on a user-initiated wake or refresh.')
    .replace("    el('libraryRefresh').disabled = busy || launchPending || !!refreshPending;",
      "    el('libraryRefresh').disabled = busy || launchPending;");
  if(file==='wasm/static/js/utils.js')source=source.replace("  Object.defineProperty(this, '_availabilityCursor', { value: 0, writable: true });\n",'');
  return source;
}
module.exports={normalize};
