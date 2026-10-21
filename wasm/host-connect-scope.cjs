'use strict';
// Exact exceptions for the shared, menu-only startup connection coordinator.
// Unknown edits remain visible to the older streaming/launch scope guards.
const cp=require('child_process'),crypto=require('crypto');
const sections={
  'wasm/static/js/utils.js':[
    ['function NvHTTP(', '// Unlike Promise.race()', '7303a2b5eba53a092c7f4e0a13bae6c86be3ed4fcf1ccffc14857dd12326afec'],
    ['  refreshServerInfoScoped:', '  connect:', 'f3fd6efec62389ae23482605ae479cb5b3c911060d34e9060d9b2bc92699dc3d'],
    ['  connect:', '  getUid:', '1b236be755955c0b432aa4e61bb322ef26c7f43d5ebf9c8318c37ef1a661546b'],
    ['  pollServer:', '  // Initially pings', 'b598fa63db02fb28a92878b1bc24a7ab3b63056759d46013eebd5801199d46b0'],
    ['  selectServerAddress:', '  toString:', '2a926c462dd9f0a135c377b5510e4bbb64d5098444d2c599d9f73474411577ca'],
    ['  // App-list availability:', '  getAppListWithCacheFlush:', '54ef232ceba5a26fa951f8a8ca4371c797278650cfa8734a666d98186a074766']
  ],
  'wasm/platform/console-library.js':[
    ['  function connect(', '  function refresh(', '13a35ac0adcfa3bd4ddc43ef86b77f62fb954fb3032424ece882fb8be39520c4'],
    ['  function refresh(', '  function focusCards(', 'b9ee09c4f494d04cce9e12bb6f894097f49511cdbe26a3eed10ccfea837a3697']
  ],
  'wasm/platform/index.js':[
    ['function beginBackgroundPollingOfHost(', 'function startPollingHosts(', '2a80f270904b5ef012b07544f19dc94fc57d4566ae20d5a0d7cd029547eac4df']
  ]
};
function normalize(file,source) {
  source=require('./manual-library-scope.cjs').normalize(file,source);
  if(!sections[file])return source;
  const old=cp.execFileSync('git',['show','ed86862:'+file],{encoding:'utf8'});
  for(const [begin,end,hash]of sections[file]) {
    const a=source.indexOf(begin),b=source.indexOf(end,a);
    if(a<0||b<=a||crypto.createHash('sha256').update(source.slice(a,b)).digest('hex')!==hash)continue;
    const x=old.indexOf(begin),y=old.indexOf(end,x);
    source=source.slice(0,a)+old.slice(x,y)+source.slice(b);
  }
  return source;
}
module.exports={normalize};
