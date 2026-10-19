'use strict';
// Exact stage-three exceptions, reversed before the older transport/streaming
// guards. Unknown neighboring changes and all historical baselines stay visible.
const cp=require('child_process'),crypto=require('crypto'),assert=require('assert');
const reference='bf05566',cache=new Map();
function digest(text){return crypto.createHash('sha256').update(text).digest('hex');}
function old(file){if(!cache.has(file))cache.set(file,cp.execFileSync('git',['show',reference+':'+file],{encoding:'utf8'}));return cache.get(file);}
const sections={
 'wasm/static/js/utils.js':[
  ['  connect:', '  getUid:', '14ddcc733c12fc99a86042f7ade354b968d239b87e55d04b83b1d9613ec933f1'],
  ['  selectServerAddress:', '  toString:', 'a21706cec61bf76fe62ce35dceb56162b5368fb7783e20305f54b3ed893480b7']
 ],
 'wasm/http.cpp':[
  ['void MoonlightInstance::DiscoverHosts(', 'MessageResult makeCert()', '157df6326b139222e46d412018b7894f7360962f3a4af19389c1e21fbde9b87b', true],
  ['  emscripten::function("discoverHosts",', '  emscripten::function("cancelMenuRequest",', '9371d246d671257c0e73b608dd66bce693f700b3ae9012cfba7cb872df86462e', true]
 ]
};
function normalize(file,source){
 for(const [begin,end,hash,added]of sections[file]||[]){
  const a=source.indexOf(begin),b=source.indexOf(end,a);
  if(a<0||b<=a||digest(source.slice(a,b))!==hash)continue;
  let replacement='';
  if(!added){const baseline=old(file),x=baseline.indexOf(begin),y=baseline.indexOf(end,x);assert(x>=0&&y>x);replacement=baseline.slice(x,y);}
  source=source.slice(0,a)+replacement+source.slice(b);
 }
 if(file==='wasm/http.cpp')source=source.replace('#include "host_discovery.hpp"\n','');
 if(file==='wasm/moonlight_wasm.hpp')source=source.replace('  void DiscoverHosts(int callbackId, std::string localIp, std::string subnet, std::string preferred, int port, uint32_t cursor);\n','');
 if(file==='wasm/platform/messages.js')source=source.replace("  'discoverHosts': (...args) => Module.discoverHosts(...args),\n",'')
  .replace("(method === 'openUrlScoped' || method === 'discoverHosts')", "method === 'openUrlScoped'");
 if(file==='wasm/menu_http.hpp')source=source.replace('submit(int id, int lane,', 'submit(int id, bool artwork,')
  .replace('    {\n      std::unique_lock<std::mutex> lock(mutex_);\n      if (stopping_ || lane < 0 || lane >= 3 || jobs_.size() >= 32 || jobs_.count(id)) {',
   '    const int lane = artwork ? 1 : 0;\n    {\n      std::unique_lock<std::mutex> lock(mutex_);\n      if (stopping_ || jobs_.size() >= 32 || jobs_.count(id)) {')
  .replace('for (auto& queue : queues_) queue.clear();','queues_[0].clear(); queues_[1].clear();')
  .replace('queues_[3]','queues_[2]').replace('workers_[3]','workers_[2]');
 return source;
}
const introduced={'wasm/host_discovery.hpp':'c2356408b1719ea155a628b2379fab9741014a98db76f380c0d3c84f59b4342b'};
function assertIntroduced(file,source){assert.strictEqual(digest(source),introduced[file],file+' approved bounded rediscovery only');}
module.exports={normalize,introduced,assertIntroduced};
