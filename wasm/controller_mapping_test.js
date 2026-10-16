'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),cp=require('child_process');
const engine=fs.readFileSync('wasm/platform/controller-mapping.js','utf8');
const menu=fs.readFileSync('wasm/platform/controller-mapping-menu.js','utf8');
const publisher=fs.readFileSync('wasm/platform/gamepad.js','utf8');
function fixture(stored) {
 let value=stored, writes=0, frames=0, notified=0, raf, pads=[];
 const heap=new Int32Array(new SharedArrayBuffer(8192)),stride=49,count=197;
 const c={console,Int32Array,Float32Array,ArrayBuffer,Atomics,Set,Math,Number,Date,isFinite,Promise,
  isInGame:false, navigator:{getGamepads:()=>pads}, performance:{now:()=>0},
  localStorage:{getItem(){return value;},setItem(k,v){assert.strictEqual(k,'moonlight.controller-mapping.v1');value=v;writes++;}},
  addEventListener(){},
  document:new Proxy({},{get(){throw Error('unexpected DOM at load');}}),
  requestAnimationFrame(fn){frames++;raf=fn;return 1;},cancelAnimationFrame(){raf=null;},
  setTimeout(){throw Error('unexpected timer');},clearTimeout(){},
  Module:{HEAP32:heap,_gamepadSnapshotAddress:()=>64,_gamepadSnapshotMaxPads:()=>4,
   _gamepadSnapshotButtonCount:()=>17,_gamepadSnapshotStride:()=>stride*4,_gamepadSnapshotWordCount:()=>count,
   _notifyGamepadSnapshot(){notified++;},_resetRumbleState(){}}};
 c.window=c;vm.createContext(c);vm.runInContext(publisher,c);
 c.addEventListener=()=>{throw Error('unexpected mapping listener at load');};
 vm.runInContext(engine,c);vm.runInContext(menu,c);
 assert.strictEqual(frames,0);assert.strictEqual(writes,0);
 return {c,heap,m:c.ControllerMapping,setPads(v){pads=v;},tick(){raf();},
  notifications:()=>notified,writes:()=>writes,stored:()=>value};
}
function pad(index=0) {
 return {index,id:'Synthetic standard controller',connected:true,timestamp:1,
  axes:[-.13,.25,0,1],buttons:Array.from({length:17},()=>({value:0,pressed:false}))};
}
let f=fixture();let cfg=f.m.get();assert(!cfg.enabled);assert(f.m.valid(cfg));
cfg.map[0]=1;assert.strictEqual(f.m.get().map[0],0,'get returns a copy');
for(const value of ['bad json','null','{}','{"version":1,"enabled":true,"map":[]}']) assert(!fixture(value).m.get().enabled);
cfg=f.m.defaults();assert(!f.m.assign(cfg,6,0));assert(!f.m.assign(cfg,16,0));
assert(!f.m.assign(cfg,0,NaN));assert(!f.m.assign(cfg,0,1.1));
assert(f.m.assign(cfg,6,7));assert.strictEqual(cfg.map[7],6);
assert(f.m.assign(cfg,0,2));assert.strictEqual(cfg.map[2],0);
let bad=f.m.defaults();bad.map[0]=1;assert(!f.m.save(bad));
bad=f.m.defaults();bad.enabled=1;assert(!f.m.save(bad));
bad=f.m.defaults();[bad.map[0],bad.map[16]]=[16,0];assert(!f.m.save(bad));
cfg.enabled=true;assert(f.m.save(cfg));assert.strictEqual(f.writes(),1);
cfg.map[0]=0;assert.strictEqual(f.m.get().map[0],2,'save copies');
assert(fixture(f.stored()).m.get().enabled,'reload restores opt-in layout');
const before=JSON.stringify(f.m.get());f.c.localStorage.setItem=()=>{throw Error('quota');};
assert(!f.m.save(f.m.defaults()));assert.strictEqual(JSON.stringify(f.m.get()),before);
f.c.isInGame=true;assert(!f.m.save(f.m.defaults()));f.c.isInGame=false;
f=fixture();f.c._gpButtonCount=17;const original=f.c._gpBuildSnapshot;
assert(!f.m.prepareSession());assert.strictEqual(f.m.sessionBuilder(original),original,'OFF has no wrapper');
cfg=f.m.defaults();cfg.enabled=true;assert(f.m.save(cfg));f.m.prepareSession();
assert.strictEqual(f.m.sessionBuilder(original),original,'identity needs no wrapper');
// Compare production snapshots against a reference permutation for random cycles,
// multiple controllers, missing indices, exact float bits and disconnects.
let seed=74123;function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
const digital=[0,1,2,3,4,5,8,9,10,11,12,13,14,15];
for(let round=0;round<120;round++) {
 f=fixture();cfg=f.m.defaults();cfg.enabled=true;
 for(let i=0;i<35;i++)f.m.assign(cfg,digital[Math.floor(random()*14)],digital[Math.floor(random()*14)]);
 if(round%2)f.m.assign(cfg,6,7);
 assert(f.m.save(cfg));assert(f.m.prepareSession());
 let pads=[pad(0),null,pad(2),pad(3)];f.setPads(pads);f.c.startGamepadSnapshot(false);
 let builder=f.m.sessionBuilder(f.c._gpBuildSnapshot);
 for(let frame=0;frame<20;frame++) {
  for(const p of pads.filter(Boolean)) {
   p.timestamp++;p.axes[0]=random()*2-1;
   for(let i=0;i<17;i++){p.buttons[i].value=random();p.buttons[i].pressed=random()>.8;}
   p.buttons[4].pressed=false; // Hotkeys have their own test below.
  }
  if(frame===9)pads[0]=null;
  if(frame===14)pads[0]=pad(0);
  f.c._gpBuildSnapshot(pads);const raw=Array.from(f.c._gpNextWords);
  const input=JSON.stringify(pads);builder(pads);assert.strictEqual(JSON.stringify(pads),input,'never mutates browser state');
  const expected=raw.slice();
  for(let slot=0;slot<4;slot++) {
   const off=1+49*slot,analog=off+15,pressed=analog+17;if(!raw[off])continue;
   for(let s=0;s<17;s++){expected[analog+cfg.map[s]]=raw[analog+s];expected[pressed+cfg.map[s]]=raw[pressed+s];}
  }
  assert.deepStrictEqual(Array.from(f.c._gpNextWords),expected,'exact button bits, axes and capabilities');
 }
 f.tick();const n=f.notifications();f.tick();assert.strictEqual(f.notifications(),n,'idle does not publish or wake');
 // A new pending preference cannot mutate the builder already chosen for a stream.
 const old=Array.from(f.c._gpNextWords);assert(f.m.save(f.m.defaults()));f.m.prepareSession();
 builder(pads);assert.deepStrictEqual(Array.from(f.c._gpNextWords),old);
 f.c.stopGamepadSnapshot();
}
f=fixture();cfg=f.m.defaults();cfg.enabled=true;f.m.assign(cfg,4,0);f.m.assign(cfg,8,3);f.m.save(cfg);f.m.prepareSession();
const p=pad();f.setPads([p]);f.c.startGamepadSnapshot(false);
const builder=f.m.sessionBuilder(f.c._gpBuildSnapshot);
for(const combo of [[8,9,4,5],[8,4,5,2]]) {
 for(const b of p.buttons){b.pressed=false;b.value=0;}
 for(const i of combo){p.buttons[i].pressed=true;p.buttons[i].value=1;}
 f.c._gpBuildSnapshot([p]);const expected=Array.from(f.c._gpNextWords);builder([p]);
 assert.deepStrictEqual(Array.from(f.c._gpNextWords),expected,'physical session shortcuts preserved');
}
f.c._gpButtonCount=18;assert.strictEqual(f.m.sessionBuilder(f.c._gpBuildSnapshot),f.c._gpBuildSnapshot);
// Source guards remain exact outside the explicit integration points.
const scope=require('./controller-mapping-scope.cjs');
for(const file of ['wasm/platform/index.js','wasm/platform/navigation.js','wasm/platform/gamepad.js','wasm/index.html']) {
 const current=fs.readFileSync(file,'utf8'),old=cp.execFileSync('git',['show','9b6687e:'+file],{encoding:'utf8'});
 assert.strictEqual(scope.normalize(file,current),old,file+' approved mapping integration only');
 assert.notStrictEqual(scope.normalize(file,current+'\n// unexpected change'),old,'negative scope fixture');
}
for(const label of ['l1','l2','l3','r1','r2','r3'])assert(menu.includes('cm-'+label+'\">'+label.toUpperCase()+'</span>'));
assert(!/(?:pad|gamepad)\.id\b|console\./.test(engine+menu),'no controller identifiers or new logs');
console.log('controller_mapping_test: defaults, validation, persistence, OFF identity, 2400 production snapshots, exact scope and menu lazy-load OK');
