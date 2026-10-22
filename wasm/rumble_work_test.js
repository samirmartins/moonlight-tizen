'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),cp=require('child_process');
const file='wasm/platform/gamepad.js',current=fs.readFileSync(file,'utf8');
const baseline=cp.execFileSync('git',['show','v3.4.4:'+file],{encoding:'utf8'});
const normalize=(file,source)=>require('./rumble-work-scope.cjs').normalize(file,
 require('./library-navigation-scope.cjs').normalize(file,source));
assert.strictEqual(normalize(file,current),baseline,'only inactive rumble slots may differ');
for(const [from,to] of [['_RUMBLE_MIN_INTERVAL_MS = 100','_RUMBLE_MIN_INTERVAL_MS = 200'],
  ['duration: _RUMBLE_DURATION_MS','duration: 1000'],['actuator.reset()','actuator.pulse(0, 0)']]) {
  assert.notStrictEqual(normalize(file,current.replace(from,to)),baseline,'policy changes rejected');
}
const prefix=fs.readFileSync('wasm/gamepad_snapshot_test.js','utf8').split('// A physical index hole')[0]
  .replace("fs.readFileSync('wasm/platform/gamepad.js', 'utf8')",'source');
function run(source,body) {
  const output={};
  vm.runInNewContext(prefix+`
    context.getStreamingGamepadMask();context.startGamepadSnapshot(true);
    let rumbleLoads=0;
    const originalAtomics=context.Atomics;
    context.Atomics=Object.create(originalAtomics);
    context.Atomics.load=function(heap,index){
      if(index>=(rumblePtr>>2) && index<(rumblePtr>>2)+4)rumbleLoads++;
      return originalAtomics.load(heap,index);
    };
  `+body,{require,console,source,output});
  return output;
}
for(let count=0;count<=4;count++) {
  const body=`
    context._gpLogicalPads=Array.from({length:${count}},()=>pad);
    for(let i=0;i<1000;i++)context._rumbleNeedsPump(i);
    for(let i=0;i<1000;i++)context._rumblePump();
    output.loads=rumbleLoads;
  `;
  assert.strictEqual(run(baseline,body).loads,8000);
  assert.strictEqual(run(current,body).loads,count*2000);
}
// Controlled Promise settlements include failures, preemption, watchdogs,
// stops, callback races and hotplug; compare all physical calls, not just totals.
for(const mode of ['resolved','pending','errors']) {
  const body=`
    let rng=74123,callbacks=[],trace=[],attempts=0;
    const random=()=>rng=(Math.imul(rng,1664525)+1013904223)>>>0;
    const controllers=Array.from({length:4},(_,slot)=>({index:slot,id:'Synthetic standard controller',connected:true,
      timestamp:1,axes:[0,0,0,0],buttons:makeButtons(),vibrationActuator:{
        playEffect(type,effect){
          trace.push({slot,at:now,type,effect});attempts++;
          if('${mode}'==='errors'&&attempts%17===0)throw Error('synthetic transient');
          return {then(ok,bad){callbacks.push({ok,bad});}};
        },
        reset(){trace.push({slot,at:now,type:'reset'});return {then(ok,bad){callbacks.push({ok,bad});}};}
      }}));
    for(let frame=0;frame<10000;frame++) {
      now=frame*16;
      if(frame%113===0) {
        const count=random()%5;pads=controllers.slice(0,count);
        for(const p of pads)p.timestamp++;
      }
      for(let slot=0;slot<4;slot++)if(random()%7===0)Atomics.store(heap32,(rumblePtr>>2)+slot,random()%5===0?0:random()|1);
      rafCallback();
      if(timerCallback){const task=timerCallback;timerCallback=null;task();}
      if(callbacks.length && ('${mode}'!=='pending'||frame%53===0)) {
        const item=callbacks.shift();
        if('${mode}'==='errors'&&random()%11===0)item.bad(Error('synthetic rejection'));else item.ok();
      }
    }
    context.stopGamepadSnapshot();
    callbacks.reverse().forEach(item=>item.ok());
    output.trace=JSON.stringify(trace);output.loads=rumbleLoads;
  `;
  const before=run(baseline,body),after=run(current,body);
  assert.strictEqual(after.trace,before.trace,mode+' exact physical timing/magnitudes/duration/stops');
  assert(after.loads<before.loads,mode+' inactive work reduced');
}
console.log('rumble_work_test: 0-4 pads, one-pad shared reads 4 -> 1, 30000 frames with exact call traces, hotplug, errors and stale settlements OK');
