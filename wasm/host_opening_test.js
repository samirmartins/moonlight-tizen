'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const index=fs.readFileSync('wasm/platform/index.js','utf8');
let opens=0,wakes=0,saves=0,polls=0,pairSuccess,pairFailure,next;
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const host={serverUid:'fixture',online:true,paired:true};
const c={console:{error(){}},Promise,isInGame:false,isDialogOpen:false,isPairingInProgress:false,
  hostOpenRequest:null,hosts:{fixture:host},api:host,Views:{Apps:{}},Navigation:{push(){},switch(){},change(){}},
  ConsoleLibrary:{visible:()=>true},WakeHost:{open(){wakes++;}},snackbarLogLong(){},stopPollingHosts(){},
  saveHosts(){saves++;},startPollingHosts(){polls++;},showApps(){opens++;return next.promise;},
  pairingDialog(h,ok,bad){pairSuccess=ok;pairFailure=bad;}};
vm.createContext(c);
vm.runInContext(index.slice(index.indexOf('function hostChosen('),index.indexOf('// Handles the change of input mode')),c);
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
(async()=>{
  next=deferred();c.hostChosen(host);c.hostChosen(host);assert.strictEqual(opens,1);
  next.resolve();await flush();assert.strictEqual(c.hostOpenRequest,null);
  next=deferred();c.hostChosen(host);next.reject(Error('failure'));await flush();assert.strictEqual(c.hostOpenRequest,null);
  c.showApps=()=>{throw Error('sync failure');};c.hostChosen(host);assert.strictEqual(c.hostOpenRequest,null);
  c.showApps=()=>{opens++;return next.promise;};
  host.online=false;c.hostChosen(host);assert.strictEqual(wakes,1);assert.strictEqual(c.hostOpenRequest,null);
  host.online=true;host.paired=false;c.hostChosen(host);c.hostChosen(host);assert(c.hostOpenRequest);
  pairFailure();assert.strictEqual(c.hostOpenRequest,null);assert.strictEqual(polls,1);
  next=deferred();c.hostChosen(host);pairSuccess();assert.strictEqual(saves,1);next.resolve();await flush();assert.strictEqual(c.hostOpenRequest,null);
  c.hostChosen(host);delete c.hosts.fixture;pairSuccess();assert.strictEqual(saves,1);assert.strictEqual(c.hostOpenRequest,null);
  c.tizen={application:{getAppMetaData:()=>[{key:'http://samsung.com/tv/metadata/use.game.mode',value:'true'}]}};c.appInfo={id:'fixture'};
  vm.runInContext(index.slice(index.indexOf('function getAppVariant('),index.indexOf('function loadUserData(')),c);
  assert.strictEqual(c.getAppVariant(),'ForceGM');c.tizen.application.getAppMetaData=()=>[];assert.strictEqual(c.getAppVariant(),'Normal');
  c.tizen.application.getAppMetaData=()=>{throw Error('unsupported');};assert.strictEqual(c.getAppVariant(),'variant unavailable');
  assert(index.includes("html('Error: ' + escapeHTML(nvhttpHost.hostname)"));
  assert(index.includes('onFailure(); // Release the PC-opening guard'));
  console.log('host_opening_test: duplicate open, async/sync error, offline/pairing/cancel, stale host and variant metadata OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
