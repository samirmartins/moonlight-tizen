'use strict';
// Run the real launcher with bounded synthetic DOM, PC, clock and audio inputs.
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('wasm/platform/console-library.js','utf8');
function fixture(options={}) {
 const nodes=new Map(),timers=new Map(),launched=[],calls={connect:0,list:0,wake:0,audio:0,close:0};let timerId=0;
 function node(name) {
  if(!nodes.has(name))nodes.set(name,{id:name,disabled:false,hidden:false,checked:false,style:{},children:[],dataset:{},textContent:'',classList:{add(){},remove(){},toggle(){}},
   setAttribute(){},appendChild(n){this.children.push(n);},querySelector(){return node('image');},scrollIntoView(){},click(){if(this.disabled)return;this.checked=!this.checked;if(this.onchange)this.onchange();else if(this.onclick)this.onclick();}});
  return nodes.get(name);
 }
 const apps=[{id:1,title:'Playnite'},{id:2,title:'Example Game'}];
 const record={apps,favorites:[],recent:[],focus:2,...options.record};
 let stored=JSON.stringify({preferred:'fixture-pc',hosts:{'fixture-pc':record}});
 const host={serverUid:'fixture-pc',hostname:'Fixture PC',online:options.online!==false,paired:options.paired!==false,currentGame:options.current||0,macAddress:options.noMac?'':'12:34:56:78:9A:BC',_memCachedApplist:apps,
  connect(){calls.connect++; if(options.delayed)return new Promise(r=>host.resolve=r);return host.online?Promise.resolve('fixture.invalid'):Promise.reject(Error('offline'));},
  getAppListWithCacheFlush(){calls.list++;return Promise.resolve(options.missing?[apps[1]]:apps);},
  getBoxArt(){return Promise.resolve('fixture');},
  sendWOL(){calls.wake++;if(options.wakeDelayed)return new Promise(r=>host.resolveWake=r);if(options.wakeFailure)return Promise.reject(Error('send failed'));if(!options.stayOffline)host.online=true;return Promise.resolve();}};
 const c={console:{log(){},warn(){},error(){}},Promise,hosts:{'fixture-pc':host},isInGame:false,isDialogOpen:false,Views:{Apps:{},AppsNav:{}},
  localStorage:{getItem(){return stored;},setItem(k,v){stored=v;}},
  setTimeout(fn,ms){timers.set(++timerId,{fn,ms});return timerId;},clearTimeout(id){timers.delete(id);},
  document:{getElementById:node,body:node('body'),createDocumentFragment(){return node('fragment-'+nodes.size);},createElement(){return node('created-'+nodes.size);}},
  $(){return {children(){return this;},show(){},hide(){}};},
  Navigation:{change(){},start(){},pop(){}},focusElement(){},showAppsMode(){},stopPollingHosts(){},stopSubnetScanner(){},showHosts(){},
  getComputedStyle(){return {gridTemplateColumns:'1fr 1fr'};},
  normalizeWakeMac(v){return v;},prepareStreamAudio(){calls.audio++;c._mlAudioCtx={state:options.audioBlocked?'suspended':'running',resume(){return new Promise(()=>{});}};},
  stopAudioScheduler(close){if(close&&c._mlAudioCtx){calls.close++;c._mlAudioCtx=null;}},
  startGame(h,app,audio){launched.push({app,audio});c.isInGame=true;c.ConsoleLibrary.suspend();},
  WakeHost:{open(){}},hostChosen(){},snackbarLog(){},exitAppDialog(){}};
 c.window=c;vm.createContext(c);vm.runInContext(fs.readFileSync('wasm/platform/menu-tools.js','utf8').split('function openUtilityDialog')[0],c);
 vm.runInContext(source,c);
 const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
 async function tick(ms) {
  const entry=Array.from(timers.entries()).find(([id,t])=>t.ms===ms);
  assert(entry,'Missing timer '+ms);timers.delete(entry[0]);entry[1].fn();await flush();
 }
 return {c,node,host,timers,calls,launched,flush,tick,prefs:()=>JSON.parse(stored).hosts['fixture-pc']};
}
(async()=>{
 const html=fs.readFileSync('wasm/index.html','utf8');
 const css=fs.readFileSync('wasm/static/css/console-library.css','utf8');
 for(const name of ['libraryAutoStart','libraryAutoWake','libraryStartup','startAutomatic']){
  assert(!source.includes(name),'Removed automatic launcher code: '+name);
  assert(!html.includes(name),'Removed automatic launcher UI: '+name);
 }
 assert(!css.includes('.console-startup'));
 const cases=Number(process.env.ML_STARTUP_CASES||24),seed=Number(process.env.ML_STRESS_SEED||12345);
 assert(Number.isInteger(cases)&&cases>0&&cases<=100000);
 assert(Number.isInteger(seed)&&seed>=0&&seed<=0xffffffff);
 let rng=seed;
 for(let index=0;index<cases;index++){
  rng=(Math.imul(rng,1664525)+1013904223)>>>0;
  const online=!!(rng&0x10000),wake=!!(rng&0x20000);
  const f=fixture({online,record:{startupApp:1,startupWake:wake,favorites:[2],recent:[1],focus:2}});
  const ready=rng&1?['hosts','runtime']:['runtime','hosts'];
  try {
   ready.forEach(part=>f.c.ConsoleLibrary.ready(part));await f.flush();
   assert.strictEqual(f.calls.connect,1,'The normal library refresh remains');
   assert.strictEqual(f.launched.length,0);assert.strictEqual(f.calls.wake,0);assert.strictEqual(f.calls.audio,0);
   f.c.ConsoleLibrary.ready('runtime');f.c.ConsoleLibrary.ready('hosts');await f.flush();
   assert.strictEqual(f.calls.connect,1,'Readiness is idempotent');
   assert.deepStrictEqual(f.prefs().favorites,[2]);assert.deepStrictEqual(f.prefs().recent,[1]);
   assert.strictEqual(f.prefs().focus,2);
   if(!online){await f.tick(5000);assert.strictEqual(f.calls.wake,0);assert.strictEqual(f.launched.length,0);}
   // Old candidate preferences must never wake or launch, but manual Play still works.
   f.node('libraryPlay').click();await f.flush();
   assert.strictEqual(f.launched.length,1);assert.strictEqual(f.launched[0].app,2);
   assert.strictEqual(f.calls.wake,online?0:1);
   assert.strictEqual(f.calls.audio,online?0:1);
   f.c.ConsoleLibrary.suspend();await f.flush();assert.strictEqual(f.timers.size,0);
  } catch(error) {
   console.error('STRESS_CASE '+JSON.stringify({seed,index,online,wake,ready}));throw error;
  }
 }
 let f=fixture({online:false,wakeDelayed:true,record:{startupApp:1,startupWake:true}});
 ['hosts','runtime'].forEach(part=>f.c.ConsoleLibrary.ready(part));await f.flush();
 f.node('libraryPlay').click();assert.strictEqual(f.calls.wake,1);
 f.node('libraryPlay').click();f.c.ConsoleLibrary.accept();assert.strictEqual(f.calls.wake,1);
 f.node('libraryCancel').click();f.host.online=true;f.host.resolveWake();await f.flush();
 assert.strictEqual(f.launched.length,0);assert.strictEqual(f.calls.close,1);
 f.c.ConsoleLibrary.suspend();assert.strictEqual(f.timers.size,0);
 f=fixture({delayed:true,record:{startupApp:1,startupWake:true}});
 ['runtime','hosts'].forEach(part=>f.c.ConsoleLibrary.ready(part));await f.flush();
 f.c.ConsoleLibrary.settings();f.host.resolve();await f.flush();
 assert.strictEqual(f.launched.length,0);assert.strictEqual(f.calls.wake,0);assert.strictEqual(f.calls.audio,0);
 assert(!f.c.ConsoleLibrary.visible());
 console.log('startup_app_test: '+cases+' cases; obsolete startup preferences inert, manual Play/WoL preserved, no automatic audio/launch, cancellation and settings return OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
