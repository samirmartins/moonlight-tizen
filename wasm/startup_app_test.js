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
 let f=fixture();f.c.ConsoleLibrary.ready('runtime');f.c.ConsoleLibrary.ready('hosts');await f.flush();
 assert.strictEqual(f.launched.length,0);assert.strictEqual(f.calls.wake,0);assert.strictEqual(f.calls.audio,0);
 assert(!f.node('libraryAutoStart').checked&&f.node('libraryAutoWake').disabled);
 f.node('libraryAutoStart').click();assert(f.node('libraryAutoWake').checked&&f.prefs().startupApp>0);
 const chosen=f.prefs().startupApp;f.node('libraryAutoWake').click();assert.strictEqual(f.prefs().startupWake,false);
 f.node('libraryAutoStart').click();assert(f.node('libraryAutoWake').disabled);
 f.node('libraryAutoStart').click();assert.strictEqual(f.prefs().startupWake,true);
 f.c.ConsoleLibrary.move(1,0);assert.strictEqual(f.prefs().startupApp,chosen,'Browsing must not retarget startup');
 f=fixture({record:{startupApp:1,startupWake:true}});
 f.c.ConsoleLibrary.ready('runtime');f.c.ConsoleLibrary.ready('hosts');await f.flush();
 assert.strictEqual(f.calls.connect,0,'Startup waits for settings');
 f.c.ConsoleLibrary.ready('settings');await f.tick(0);await f.tick(0);
 assert.deepStrictEqual(f.launched,[{app:1,audio:true}]);assert.strictEqual(f.calls.wake,0);assert.strictEqual(f.calls.audio,1);
 f.c.ConsoleLibrary.ready('runtime');f.c.ConsoleLibrary.ready('settings');assert.strictEqual(f.launched.length,1);
 f.c.isInGame=false;await f.c.ConsoleLibrary.open(f.host);await f.flush();assert.strictEqual(f.launched.length,1,'No restart when returning to the library');
 f=fixture({online:false,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);await f.tick(1000);await f.tick(0);
 assert.strictEqual(f.calls.wake,1);assert.strictEqual(f.launched.length,1);
 // Automatic wake owns one operation; manual clicks cannot duplicate it.
 f=fixture({online:false,wakeDelayed:true,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);
 f.node('libraryPlay').click();f.c.ConsoleLibrary.accept();assert.strictEqual(f.calls.wake,1);
 f.node('libraryCancel').click();f.host.online=true;f.host.resolveWake();await f.flush();
 assert.strictEqual(f.launched.length,0);assert.strictEqual(f.calls.audio,0);
 assert(!Array.from(f.timers.values()).some(t=>t.ms===1000),'Cancelled wake must not schedule a check');
 // Disabling startup WoL never disables the existing manual Wake & play.
 f=fixture({online:false,record:{startupApp:1,startupWake:false}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);
 f.node('libraryCancel').click();f.node('libraryPlay').click();await f.flush();
 assert.strictEqual(f.calls.wake,1);assert.strictEqual(f.launched.length,1);
 f=fixture({delayed:true,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);
 f.c.ConsoleLibrary.settings();f.host.resolve();await f.flush();
 assert.strictEqual(f.launched.length,0);assert.strictEqual(f.calls.wake,0);
 // A timed-out address probe cannot resume the automatic sequence later.
 f=fixture({delayed:true,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);
 const oldProbe=f.host.resolve;await f.tick(8000);
 assert.strictEqual(f.calls.wake,1);oldProbe();await f.flush();
 assert.strictEqual(f.calls.list,0);assert.strictEqual(f.launched.length,0);
 await f.tick(1000);f.host.resolve();await f.flush();await f.tick(0);
 assert.strictEqual(f.launched.length,1);assert.strictEqual(f.calls.wake,1);
 f=fixture({online:false,record:{startupApp:1,startupWake:false}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);
 assert.strictEqual(f.calls.wake,0);assert.strictEqual(f.calls.audio,0);
 await f.tick(60000);assert(!f.node('libraryPlay').disabled);assert.strictEqual(f.launched.length,0);
 f=fixture({online:false,noMac:true,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);
 assert.strictEqual(f.calls.wake,0);assert.match(f.node('libraryStatus').textContent,/MAC/);
 f=fixture({online:false,wakeFailure:true,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);assert.match(f.node('libraryStatus').textContent,/Could not send/);
 f=fixture({missing:true,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);assert.strictEqual(f.launched.length,0);assert.match(f.node('libraryStatus').textContent,/no longer available/);
 f=fixture({delayed:true,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);
 f.node('libraryCancel').click();f.host.resolve();await f.flush();assert.strictEqual(f.launched.length,0);assert.strictEqual(f.calls.audio,0);
 f=fixture({audioBlocked:true,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);await f.tick(0);await f.tick(1500);
 assert.strictEqual(f.launched.length,0);assert.strictEqual(f.calls.close,1);assert.match(f.node('libraryStatus').textContent,/button press/);
 f=fixture({current:2,record:{startupApp:1,startupWake:true}});
 ['settings','hosts','runtime'].forEach(s=>f.c.ConsoleLibrary.ready(s));await f.tick(0);await f.tick(0);
 assert.strictEqual(f.calls.audio,0);assert.strictEqual(f.launched.length,0);assert.match(f.node('libraryStatus').textContent,/Another app/);
 console.log('startup_app_test: OFF, auto-WoL selection, persistence, fixed target, settings readiness, online/offline launch, cancellation, timeouts, missing app/MAC, audio restrictions and active-app guard OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
