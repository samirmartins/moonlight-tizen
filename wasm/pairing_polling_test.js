'use strict';
// Production Add-PC, pairing dialog and polling; synthetic DOM/native handshake.
const fs=require('fs'),cp=require('child_process'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('wasm/platform/index.js','utf8');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(options={},code=source){
 const nodes=new Map(),timers=new Map();let serial=0;
 const f={checks:0,pairs:0,cancelled:0,saves:0,added:0,success:0,failure:0,connections:[],preflights:[],gate:deferred(),oldReplies:[],options};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{style:{},value:'',checked:false,disabled:false,open:false,handlers:{},classList:{toggle(){}},
  showModal(){this.open=true;},close(){this.open=false;},blur(){}});return nodes.get(id);};
 function q(selector){const n=typeof selector==='string'?node(selector.replace(/^#/,'')):selector;
  return {off(name){delete n.handlers[name];return this;},on(name,fn){n.handlers[name]=fn;return this;},
   val(v){if(v===undefined)return n.value;n.value=v;return this;},prop(k,v){if(v===undefined)return n[k];n[k]=v;return this;},
   addClass(){return this;},removeClass(){return this;},html(v){n.html=v;return this;},text(v){if(v===undefined)return n.textContent;n.textContent=v;return this;}};
 }
 const c={Promise,console:{log(){},warn(){},error(){}},isInGame:false,isDialogOpen:false,isPairingInProgress:false,wasPairingCanceled:false,
  pairingCert:options.noCert?null:'synthetic runtime flag',activePolls:{},hosts:{},myUniqueid:'fixture',
  document:{hidden:false,querySelector:s=>node(s.replace(/^#/,'')),getElementById:node,activeElement:node('active')},
  setTimeout(fn,ms){timers.set(++serial,{fn,ms});return serial;},clearTimeout(id){timers.delete(id);},
  ConsoleLibrary:{visible:()=>!!f.library},Navigation:{push(){},pop(){},switch(){}},Views:{AddHostDialog:{},PairingDialog:{}},
  $:q,updateHostStatusIndicator(){},snackbarLog(){},snackbarLogLong(){},updateIpAddressInputValidationState(){},initIpAddressFields(){},
  parseHostAndPortInput:addr=>({valid:true,addr,port:47989}),escapeHTML:s=>s,saveHosts(){f.saves++;},
  addHostToGrid:h=>{c.hosts[h.serverUid]=h;f.added++;},sendMessage(method){assert.strictEqual(method,'cancelRequest');f.cancelled++;return Promise.resolve();}};
 c.window=c;
 function background(uid){return {serverUid:uid,hostname:'Fixture',online:true,paired:false,_pollCompletionCallbacks:[],
  connect(scope){f.connections.push(scope);if(options.oldPending){const gate=deferred();f.oldReplies.push(gate);return gate.promise;}return Promise.resolve();},
  pollServer(cb,scope){assert(scope.active);f.checks++;cb(this);}};}
 c.hosts.first=background('first');c.hosts.second=background('second');
 c.NvHTTP=function(address){
  const h=background(options.existing?'first':'added');
  Object.assign(h,{address,httpPort:47989,userEnteredAddress:address,currentGame:options.busy?1:0,paired:!!options.paired,online:options.offline!==true,
   refreshServerInfoAtAddress:()=>Promise.resolve(true),
   pollServer(cb){
    f.preflights.push(cb);
    if(options.throwPoll)throw Error('synthetic preflight');
    if(!options.delayedPoll)cb(this);
   },pair(pin){assert(/^\d{4}$/.test(pin));f.pairs++;assert(c.pairingPollingPause,'polling paused before PIN exchange');return f.gate.promise;}});
  f.newHost=h;f.checkedHost=h;
  if(options.existing){
   const stored=c.hosts.first;
   Object.assign(stored,{currentGame:h.currentGame,paired:h.paired,pollServer:h.pollServer,pair:h.pair,ppkstr:'synthetic stored pin'});
   f.checkedHost=stored;
  }
  return h;
 };
 node('ipAddressTextInput').value='192.0.2.99';vm.createContext(c);
 vm.runInContext(fs.readFileSync('wasm/platform/menu-tools.js','utf8').split('function openUtilityDialog')[0],c);
 const slice=(a,b)=>{const x=code.indexOf(a),y=code.indexOf(b,x);assert(x>=0&&y>x);return code.slice(x,y);};
 vm.runInContext(slice('// Each menu visit owns','function snackbarLog('),c);
 vm.runInContext(slice('function addHostDialog()','// Add the new NvHTTP Host object'),c);
 f.flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
 f.click=id=>{const fn=node(id).handlers.click;assert(fn,'handler '+id);fn();};
 f.start=async()=>{c.startPollingHosts();await f.flush();c.addHostDialog();f.click('continueAddHost');await f.flush();};
 f.c=c;f.node=node;f.timers=timers;
 return f;
}
(async()=>{
 // Negative control: the old manual-IP path leaves existing hosts polling.
 const old=fixture({oldPending:true},cp.execFileSync('git',['show','04dfc66:wasm/platform/index.js'],{encoding:'utf8'}));
 // No PIN exchange is needed to prove the prior overlap.
 old.c.NvHTTP=function(){const h={serverUid:'added',hostname:'Fixture',address:'192.0.2.99',httpPort:47989,
  refreshServerInfoAtAddress:()=>Promise.resolve(),pollServer(){}};return h;};
 await old.start();assert.strictEqual(Object.keys(old.c.hostPollScopes).length,2);assert(old.connections.every(s=>s.active));old.c.stopPollingHosts();
 // New/existing manual IPs use the same entry, cancel existing requests/timers
 // and block both batch and individual poll restarts during preflight/handshake.
 for(const mode of ['success','failure','cancel-success','cancel-failure'])for(const existing of [false,true]){
  const f=fixture({existing,oldPending:true,delayedPoll:true});await f.start();
  assert(f.c.pairingPollingPause);assert(f.connections.every(s=>!s.active));assert.strictEqual(Object.keys(f.c.activePolls).length,0);
  const count=f.connections.length;f.c.startPollingHosts();f.c.beginBackgroundPollingOfHost(f.c.hosts.first);assert.strictEqual(f.connections.length,count);
  // For the existing-host branch the stored object, not the temporary lookup,
  // owns pairing, preserving credentials and preferences.
  f.preflights[0](f.checkedHost);f.preflights[0](f.checkedHost);assert.strictEqual(f.pairs,1);
  if(existing)assert.strictEqual(f.c.hosts.first.ppkstr,'synthetic stored pin');
  if(mode.startsWith('cancel')){f.click('cancelPairing');assert(!f.c.pairingPollingPause);assert.strictEqual(f.cancelled,1);}
  if(mode.endsWith('failure')||mode==='failure')f.gate.reject(Error('synthetic native failure'));else f.gate.resolve(true);
  await f.flush();assert(!f.c.pairingPollingPause);
  const resumes=f.connections.length;
  if(mode==='success'){assert.strictEqual(f.added,existing?0:1);assert.strictEqual(f.saves,1);}
  else{assert.strictEqual(f.added,0);assert.strictEqual(f.saves,0);}
  if(mode==='failure'){f.click('cancelPairing');await f.flush();assert.strictEqual(f.connections.length,resumes,'Close must not resume twice');}
  const hosts=mode==='success'&&!existing?3:2;
  assert.strictEqual(Object.keys(f.c.hostPollScopes).length,hosts);
  f.oldReplies.forEach(g=>g.resolve());await f.flush();
  assert.strictEqual([...f.timers.values()].filter(t=>t.ms===5000).length,hosts,'late polls cannot re-arm old timers');
  f.c.stopPollingHosts();
 }
 // Terminal branches before a native PIN exchange also release the pause.
 for(const options of [{offline:true},{paired:true},{busy:true},{throwPoll:true},{noCert:true}]){
  const f=fixture(options);await f.start();assert(!f.c.pairingPollingPause);assert.strictEqual(f.pairs,0);
  assert.strictEqual(Object.keys(f.c.hostPollScopes).length,options.paired?3:2);f.c.stopPollingHosts();
 }
 // A second entry cannot steal the first pause or resume its polling; hiding
 // during preflight prevents the delayed callback from opening a PIN dialog.
 for(const abort of ['duplicate','hidden','gameplay']){
  const f=fixture({delayedPoll:true}),h=new f.c.NvHTTP('192.0.2.99');let denied=0;
  f.c.pairingDialog(h,()=>{},()=>f.failure++);const owner=f.c.pairingPollingPause;
  if(abort==='duplicate'){
   f.c.pairingDialog(h,()=>{throw Error('duplicate entry');},()=>{denied++;f.c.startPollingHosts();});
   assert.strictEqual(denied,1);assert.strictEqual(f.c.pairingPollingPause,owner);
   assert.strictEqual(f.connections.length,0);f.c.document.hidden=true;
  }else if(abort==='hidden')f.c.document.hidden=true;else f.c.isInGame=true;
  f.preflights[0](h);assert.strictEqual(f.pairs,0);assert.strictEqual(f.failure,1);assert(!f.c.pairingPollingPause);
  assert.strictEqual(f.connections.length,0);
 }
 // Direct host-card pairing must not restart polls when its callback enters
 // the library, gameplay, or completes while hidden.
 for(const finish of ['library','gameplay','hidden','failure-restart']){
  const f=fixture();f.c.startPollingHosts();await f.flush();const h=new f.c.NvHTTP('192.0.2.99');
  f.c.pairingDialog(h,()=>{f.success++;if(finish==='library')f.library=true;if(finish==='gameplay')f.c.isInGame=true;},()=>{f.failure++;f.c.startPollingHosts();});
  const count=f.connections.length;
  if(finish==='hidden'){f.c.document.hidden=true;f.gate.resolve();}else if(finish==='failure-restart')f.gate.reject(Error('failure'));else f.gate.resolve();
  await f.flush();assert(!f.c.pairingPollingPause);
  assert.strictEqual(f.connections.length,finish==='failure-restart'?count+2:count);
  assert.strictEqual(f.success+f.failure,1);f.c.stopPollingHosts();
 }
 const normalize=require('./pairing-polling-scope.cjs').normalize;
 for(const file of ['wasm/platform/index.js','wasm/platform/app-lifecycle.js']){
  const current=fs.readFileSync(file,'utf8'),baseline=cp.execFileSync('git',['show','04dfc66:'+file],{encoding:'utf8'});
  assert.strictEqual(normalize(file,current),baseline);assert.notStrictEqual(normalize(file,current+'\n// unexpected'),baseline);
 }
 console.log('pairing_polling_test: manual-IP polling pause, in-flight cancellation, one-time resume, terminal branches, stale replies and menu/gameplay/hidden isolation passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
