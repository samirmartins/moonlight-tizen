'use strict';
const fs = require('fs'), vm = require('vm'), cp = require('child_process'), assert = require('assert');
// Reuse the input fixture; each scenario gets isolated state and fake time.
const prefix = fs.readFileSync('wasm/gamepad_snapshot_test.js', 'utf8').split('// A physical index hole')[0]
  .replace("fs.readFileSync('wasm/platform/gamepad.js', 'utf8')", 'source');
const current = fs.readFileSync('wasm/platform/gamepad.js', 'utf8');
function run(body, source = current) {
  const output = {};
  vm.runInNewContext(prefix + `
    context.getStreamingGamepadMask(); context.startGamepadSnapshot(true);
    const pack = n => (n << 16) | n;
    let tasks = 0;
    function tick(t, value) {
      now=t;
      if (value !== undefined) Atomics.store(heap32,rumblePtr>>2,value);
      rafCallback();
      if(timerCallback) {const f=timerCallback;timerCallback=null;tasks++;f();}
    }
  ` + body, {require, console, source, output});
  return output;
}
run(`
  actuator.playEffect=(type,effect)=>{rumbleCalls.push({type,effect});return {then(){}};};
  tick(0,pack(1000));tick(100,pack(2000));tick(500);
  const before=tasks;
  for(let t=516;t<600;t+=16)tick(t);
  assert.strictEqual(tasks,before);assert.strictEqual(rumbleCalls.length,2);
  tick(601,0);assert.strictEqual(rumbleCalls[2].type,'reset');
`);
run(`
  actuator.playEffect=()=>{rumbleCalls.push('attempt');throw Error('transient');};
  tick(0,pack(1000));tick(100);tick(399);assert.strictEqual(rumbleCalls.length,1);
  assert.strictEqual(context._rumbleRetry[0],1);
  tick(400);assert.strictEqual(rumbleCalls.length,2);
  tick(401,0);assert.strictEqual(rumbleCalls[2].type,'reset');
`);
run(`
  let failures=[];
  actuator.playEffect=()=>({then(ok,bad){failures.push(bad);}});
  tick(0,pack(1000));tick(100,pack(2000));failures[0](Error('old'));
  assert.strictEqual(context._rumbleRetry[0],0);
  failures[1](Error('current'));assert.strictEqual(context._rumbleRetry[0],1);
  tick(101,0);assert.strictEqual(context._rumbleRetry[0],0);
  context._rumbleForgetSlot(0);failures[1](Error('late'));
  assert.strictEqual(context._rumbleRetry[0],0);
`);
run(`
  actuator.playEffect=()=>{rumbleCalls.push('unsupported');const e=Error();e.name='NotSupportedError';throw e;};
  tick(0,pack(1000));tick(1000);assert.strictEqual(rumbleCalls.length,1);
  context._rumbleForgetSlot(0);tick(1100);assert.strictEqual(rumbleCalls.length,2);
`);
run(`
  pad.vibrationActuator=null;tick(0,pack(1000));tick(500);assert.strictEqual(tasks,0);
  pad.vibrationActuator=actuator;tick(600);assert.strictEqual(rumbleCalls.length,1);
`);
run(`
  let attempts=0;
  actuator.reset=()=>{attempts++;throw Error('stop failed');};
  actuator.playEffect=()=>{};
  tick(0,pack(1000));tick(10,0);tick(20);tick(409);assert.strictEqual(attempts,1);
  tick(410);assert.strictEqual(attempts,2);
`);
// Sustained effects preserve exact timing/magnitudes/duration. Fast restarts
// are intentionally rate-limited: stops no longer erase the start deadline.
const sequence = `
  actuator.playEffect=(type,effect)=>{rumbleCalls.push({at:now,type,effect});};
  actuator.reset=()=>{rumbleCalls.push({at:now,type:'reset'});};
  let rng=12345;
  for(let frame=0;frame<3000;frame++) {
    rng=(Math.imul(rng,1664525)+1013904223)>>>0;
    tick(frame*16,(rng%7===0)?pack(1+rng%65535):undefined);
  }
  output.trace=JSON.stringify(rumbleCalls);
`;
const baseline=cp.execFileSync('git',['show','v3.3.10:wasm/platform/gamepad.js'],{encoding:'utf8'});
assert.strictEqual(run(sequence).trace,run(sequence,baseline).trace);
run(`
  actuator.playEffect=(type,effect)=>rumbleCalls.push({at:now,type,effect});
  actuator.reset=()=>rumbleCalls.push({at:now,type:'reset'});
  for(let t=0;t<1008;t+=16)tick(t,t%32===0?pack(10000):0);
  const starts=rumbleCalls.filter(call=>call.type==='dual-rumble');
  assert(starts.length<=10);
  for(let i=1;i<starts.length;i++)assert(starts[i].at-starts[i-1].at>=100);
  for(const call of starts)assert.strictEqual(call.effect.weakMagnitude,10000/65535);
  assert.strictEqual(rumbleCalls.filter(call=>call.type==='reset').length,starts.length);
  tick(1020,0);const before=tasks;for(let t=1040;t<1400;t+=16)tick(t);
  assert.strictEqual(tasks,before,'no continued work after stopped');
`);
console.log('rumble_safety_test: retries, stop, stale promises, 3000-frame sustained baseline and rapid pulse rate limit OK');
