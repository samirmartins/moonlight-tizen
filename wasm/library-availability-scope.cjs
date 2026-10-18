'use strict';
// Exact, independently tested menu availability exceptions. Never hide edits
// to launch, WoL, pairing, HTTP transport, input, audio or video algorithms.
const cp=require('child_process'),crypto=require('crypto'),assert=require('assert');
const sections={
  'wasm/platform/console-library.js':[
    ['  function render(', '  function connect(', '69aafb83a791d8e5052ca5ce4dd60001981ecdc73f2776b36dc28d437b0246d2'],
    ['  function refresh(', '  function focusCards(', 'aeb361bb0e3fb3b4678c83a72d6cf8640aa79acb4c690d2d2312171f5d00ac0b'],
    ['  function open(pc)', '  function ready(', '6f2919a468f45a162ecaf7bb421d864d34c5f34059de204c908b27b31f444dfe']
  ],
  'wasm/static/js/utils.js':[
    ['  refreshServerInfoScoped:', '  connect:', '84877110dc41c386f26d1cf3ebc7b469fd1a6cd93f5a47522fa2b4e112057ac9'],
    ['  selectServerAddress:', '  toString:', 'ccd040f422db64f5cd669fc4cab20917796ceca2eb7588ae9e2711b8e9145c88']
  ]
};
function normalize(file,source) {
  if(!sections[file])return source;
  const old=cp.execFileSync('git',['show','v3.4.5:'+file],{encoding:'utf8'});
  for(const [begin,end,hash] of sections[file]) {
    const a=source.indexOf(begin),b=source.indexOf(end,a);
    assert(a>=0&&b>a,'bounded availability section');
    if(crypto.createHash('sha256').update(source.slice(a,b)).digest('hex')!==hash)continue;
    const x=old.indexOf(begin),y=old.indexOf(end,x);
    source=source.slice(0,a)+old.slice(x,y)+source.slice(b);
  }
  if(file==='wasm/platform/console-library.js')source=source
    .replace('  var refreshPending = null, refreshCovers = false;\n','')
    .replace('    refreshPending = null; refreshCovers = false;\n','')
    .replace('    // Checking never locks Play/Wake. Repeated Refresh shares the current work.',
      '    // A background check is never a lock on a user-initiated wake or refresh.')
    .replace("    el('libraryRefresh').disabled = busy || launchPending || !!refreshPending;",
      "    el('libraryRefresh').disabled = busy || launchPending;");
  return source;
}
module.exports={normalize};
