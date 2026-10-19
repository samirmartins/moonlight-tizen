'use strict';
// Exact, behaviorally tested menu-transport exceptions. Unknown neighboring
// edits remain visible; historical streaming/launch baselines never advance.
const crypto=require('crypto'),cp=require('child_process'),assert=require('assert');
const reference='7cc3eba',cache=new Map();
const sections={
 'wasm/http.cpp':[
  ['namespace {\n','#include <mkcert.h>','cec20a83b5579f60c8fe10dec834f2a8a935424b475c9e00154937b1b0994e2a'],
  ['void MoonlightInstance::OpenUrlScoped(','MessageResult makeCert()','6f59be4be3b8bbf36c83d342a939146502f155ece7fd48edcbaf0a57f9194166']
 ],
 'wasm/main.cpp':[
  ['MoonlightInstance::~MoonlightInstance()','void MoonlightInstance::OnConnectionStarted','1bbfd809451a87291e0bbc3391646d112cd9b2543179a4e9aefb7027be469a18']
 ],
 'libgamestream/http.c':[
  ['int http_request_bounded(','int http_request(const','c5ea89916516ec6c14fb07bc7e6c01c6ec0ff587f84ca6e162edd936cbe3c3f3',null],
  ['  if (menu) {','  // Use the pinned certificate','1b46b2938b1314243dddeddb79c412f3e3b06df95156ae6606dd9e2f57c703ab',null],
  ['typedef struct _MENU_SOCKET_CONTEXT','  int ret;','66e20104a2f0841755423f0c2c959a1755d2863ee34561218506566c031664a1','int http_request_bounded(']
 ],
 'libgamestream/http.h':[
  ['// Menu-only numeric/resolved','void http_free_data','21abb5f1e4187ee78e19e0e7e98d184b7d05157aa30994df355bab27a8c2bc50',null]
 ],
 'wasm/platform/messages.js':[
  ['    promise.cancel = function() {','    return promise;','c8222ba59dd76be7576badc27d23ab4ec0e70f5d36332a5b25f44723f8dbee86']
 ]
};
function old(file){if(!cache.has(file))cache.set(file,cp.execFileSync('git',['show',reference+':'+file],{encoding:'utf8'}));return cache.get(file);}
function digest(s){return crypto.createHash('sha256').update(s).digest('hex');}
function normalize(file,source){
 for(const[begin,end,hash,oldBegin=begin]of sections[file]||[]){
  const a=source.indexOf(begin),b=source.indexOf(end,a);
  if(a<0||b<=a||digest(source.slice(a,b))!==hash)continue;
  let replacement='';
  if(oldBegin!==null){const baseline=old(file),x=baseline.indexOf(oldBegin),y=baseline.indexOf(end,x);assert(x>=0&&y>x);replacement=baseline.slice(x,y);}
  source=source.slice(0,a)+replacement+source.slice(b);
 }
 if(file==='wasm/http.cpp')source=source.replace('#include <unordered_map>\n#include <curl/curl.h>\n#include <emscripten/threading.h>\n','#include <unordered_map>\n');
 if(file==='wasm/moonlight_wasm.hpp')source=source.replace('#include "menu_http.hpp"\n','')
  .replace('  mlhttp::Transport m_MenuHttp;\n','')
  .replace('  void CancelMenuRequest(int callbackId) { m_MenuHttp.cancel(callbackId); }\n','');
 if(file==='libgamestream/http.c')source=source.replace('#include <sys/socket.h>\n#include <netinet/in.h>\n','')
  .replace('  MENU_SOCKET_CONTEXT socket_context = {scopes, scope_count, 0};\n','')
  .replace('if (!menu && bracket_start','if (bracket_start');
 return source;
}
const introduced={'wasm/menu_http.hpp':'e59c8bb6f2bbee40cc98e1d64b5f6ef53ed23866f79767e88fe5e3a1e4f6a646'};
function assertIntroduced(file,source){assert.strictEqual(digest(source),introduced[file],file+' approved bounded menu transport only');}
module.exports={normalize,introduced,assertIntroduced};
