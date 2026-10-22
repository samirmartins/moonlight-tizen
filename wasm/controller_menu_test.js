'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert'),cp=require('child_process');
const file='wasm/platform/gamepad.js',source=require('./rumble-work-scope.cjs').normalize(file,fs.readFileSync(file,'utf8'));
const baseline=cp.execFileSync('git',['show','daca400:'+file],{encoding:'utf8'});
const normalize=require('./controller-menu-scope.cjs').normalize;
assert.strictEqual(normalize(file,source),baseline,'menu snapshot reuse only');
const boundary='// Streaming gamepad publisher';
assert.strictEqual(source.slice(source.indexOf(boundary)),baseline.slice(baseline.indexOf(boundary)),'complete gameplay/rumble source unchanged');
for(const [a,b] of [['setInterval(pollGamepads, 16)','setInterval(pollGamepads, 32)'],
  ["type: 'button', index: i, pressed: newButtons[i].pressed","type: 'button', index: i, pressed: false"],
  ['this.axes[i] !== newAxes[i]','this.axes[i] != newAxes[i]']]) {
 assert(source.includes(a));assert.notStrictEqual(normalize(file,source.replace(a,b)),baseline,'unexpected sampling/event mutation rejected');
}
function fixture(text=source,legacy=false) {
 let poll=null,pads=[],state,serial=0;
 const events=[],listeners=new Map(),periods=[],allocations={buttons:0,changeArrays:0};
 const navigator=legacy?{webkitGetGamepads:()=>pads}:{getGamepads:()=>pads};
 const c={navigator,console,__allocations:allocations,__inspect(value){state=value;},
  setInterval(fn,ms){assert(!poll);periods.push(ms);poll=fn;return ++serial;},clearInterval(){poll=null;},
  addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
  dispatchEvent(event){if(event.type==='gamepadinputchanged')events.push(event);for(const fn of listeners.get(event.type)||[])fn(event);},
  CustomEvent:function(type,params){this.type=type;this.detail=params.detail;}};
 c.window=c;vm.createContext(c);
 const instrumented=text.replace('  const gamepads = {};','  const gamepads = {}; __inspect(gamepads);')
  .replace('    constructor(button) {','    constructor(button) { __allocations.buttons++;')
  .replace('      const changes = [];','      const changes = []; __allocations.changeArrays++;')
  .replaceAll('if (!changes) changes = [];','if (!changes) { changes = []; __allocations.changeArrays++; }');
 vm.runInContext(instrumented+'\nwindow.testController=Controller;',c);
 return {c,events,periods,allocations,state:()=>state,setPads(value){pads=value;},
  start(){c.testController.startWatching();},stop(){c.testController.stopWatching();},
  tick(){assert(poll);poll();},running:()=>!!poll,emit(type,gamepad){c.dispatchEvent({type,gamepad});},
  onChange(fn){c.addEventListener('gamepadinputchanged',fn);}};
}
function pad(index){return {index,connected:true,buttons:Array.from({length:17},()=>({pressed:false,value:0})),axes:[0,0,0,0]};}
function snapshot(f){return Object.keys(f.state()).map(key=>{
 const p=f.state()[key];return {key,buttons:Array.from(p.buttons,b=>({pressed:b.pressed,value:b.value})),axes:Array.from(p.axes)};
});}
function compare(a,b){
 assert.deepStrictEqual(snapshot(a),snapshot(b));
 assert.strictEqual(JSON.stringify(a.events.map(e=>e.detail.changes)),JSON.stringify(b.events.map(e=>e.detail.changes)));
 assert(a.events.every(e=>Number.isInteger(e.detail.padIndex)), 'menu events identify their controller');
}
const idle=fixture(),oldIdle=fixture(baseline),p=pad(0),q=pad(0);
idle.setPads([p]);oldIdle.setPads([q]);idle.start();oldIdle.start();idle.start();oldIdle.start();
assert.deepStrictEqual(idle.periods,[16]);
const kept=idle.state()[0],buttons=kept.buttons,axes=kept.axes,firstButton=buttons[0];
idle.allocations.buttons=oldIdle.allocations.buttons=0;idle.allocations.changeArrays=oldIdle.allocations.changeArrays=0;
let oldArrayReplacements=0;
for(let i=0;i<10000;i++){
 const before=oldIdle.state()[0];const previousButtons=before.buttons,previousAxes=before.axes;
 idle.tick();oldIdle.tick();
 oldArrayReplacements+=(previousButtons!==before.buttons)+(previousAxes!==before.axes);
}
assert.strictEqual(idle.allocations.buttons,0);assert.strictEqual(idle.allocations.changeArrays,0);
assert.strictEqual(oldIdle.allocations.buttons,170000);assert.strictEqual(oldIdle.allocations.changeArrays,10000);
assert.strictEqual(oldArrayReplacements,20000);assert.strictEqual(idle.events.length,0);
assert.strictEqual(kept.buttons,buttons);assert.strictEqual(kept.axes,axes);assert.strictEqual(kept.buttons[0],firstButton);
// Mutating the browser's live values cannot mutate the copied menu state.
p.buttons[0].value=q.buttons[0].value=0.75;assert.strictEqual(kept.buttons[0].value,0);
idle.tick();oldIdle.tick();compare(idle,oldIdle);assert.strictEqual(idle.events.length,0,'analog-only value changes stay silent');
for(const f of [idle,oldIdle])f.stop();assert(!idle.running());
const a=fixture(),b=fixture(baseline),left=[pad(0),null,pad(2),null,null,pad(5)],right=[pad(0),null,pad(2),null,null,pad(5)];
a.setPads(left);b.setPads(right);a.start();b.start();let rng=12345;
for(let frame=0;frame<600;frame++) {
 rng=(Math.imul(rng,1664525)+1013904223)>>>0;
 for(const slot of [0,2,5]) {
  const index=(rng+slot)%17,axis=(rng+slot)%4,pressed=!!(rng&2),value=(rng%1000)/999;
  for(const pads of [left,right]){pads[slot].buttons[index]={pressed,value};pads[slot].axes[axis]=[0,-0,0.25,-0.75,NaN,Infinity][(rng+slot)%6];}
 }
 a.tick();b.tick();compare(a,b);
}
const retained=a.events.map(event=>JSON.stringify(event));
left[0].buttons[15].pressed=right[0].buttons[15].pressed=true;a.tick();b.tick();compare(a,b);
retained.forEach((text,index)=>assert.strictEqual(JSON.stringify(a.events[index]),text,'delivered payload was not reused'));
assert(new Set(a.events.map(e=>e.detail.changes)).size===a.events.length,'each event owns its change array');
// Layout changes preserve the original reset-without-event behavior.
for(const pads of [left,right]) {pads[0].buttons.push({pressed:false,value:0});pads[0].axes.push(0);}
a.tick();b.tick();compare(a,b);
left[0].buttons[17].pressed=right[0].buttons[17].pressed=true;a.tick();b.tick();compare(a,b);
// Hotplug, missed connection notification, browser-index holes and stop/start.
left[7]=pad(7);right[7]=pad(7);a.tick();b.tick();left[7].buttons[12].pressed=right[7].buttons[12].pressed=true;a.tick();b.tick();compare(a,b);
for(const f of [a,b])f.emit('gamepaddisconnected',{index:2});left[2]=right[2]=null;a.tick();b.tick();compare(a,b);
for(const f of [a,b])f.stop();left[0].buttons[0].pressed=right[0].buttons[0].pressed=true;
for(const f of [a,b])f.start();a.tick();b.tick();compare(a,b);
for(const f of [a,b])f.stop();assert(a.periods.every(ms=>ms===16));
// Synchronous listeners may alter inputs/layout or poll recursively. Event
// order and the snapshots visible during delivery must still match baseline.
for(const mode of ['values','layout','recursive']) {
 const one=fixture(),old=fixture(baseline),onePad=pad(0),oldPad=pad(0),seen=[];
 for(const [f,controller] of [[one,onePad],[old,oldPad]]) {
  f.setPads([controller]);f.start();let nested=false;
  f.onChange(()=>{
   if(nested)return;nested=true;seen.push(JSON.stringify(snapshot(f)));
   if(mode==='values'){controller.buttons[3].pressed=true;controller.axes[1]=0.875;}
   if(mode==='layout'){controller.buttons.push({pressed:true,value:1});controller.axes.push(-0.5);}
   if(mode==='recursive')f.tick();
  });
  controller.buttons[1].pressed=true;f.tick();
 }
 compare(one,old);assert.strictEqual(seen[0],seen[1]);one.stop();old.stop();
}
const fallback=fixture(source,true),fallbackOld=fixture(baseline,true),fp=pad(0),fq=pad(0);
for(const [f,controller] of [[fallback,fp],[fallbackOld,fq]]){f.setPads([controller]);f.start();f.tick();controller.buttons[14].pressed=true;f.tick();}
compare(fallback,fallbackOld);fallback.stop();fallbackOld.stop();
console.log('controller_menu_test: identical events/state, 16ms, hotplug/layout/restart/legacy/reentrant delivery; 10000 idle polls: Button objects 170000 -> 0, snapshot arrays 20000 -> 0, change arrays 10000 -> 0; gameplay frozen');
