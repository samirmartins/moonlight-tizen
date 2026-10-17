'use strict';
const assert=require('assert'),fs=require('fs'),cp=require('child_process'),vm=require('vm');
const {Worker}=require('worker_threads');
const file='wasm/platform/gamepad.js';
const current=fs.readFileSync(file,'utf8');
const baseline=cp.execFileSync('git',['show','v3.4.3:'+file],{encoding:'utf8'});
const normalize=require('./gamepad-publication-scope.cjs').normalize;
assert.strictEqual(normalize(file,current),baseline,'only the store loop may change');
assert.notStrictEqual(normalize(file,current.replace('base, 1);','base, 2);')),baseline,'sequence mutation rejected');
assert.notStrictEqual(normalize(file,current.replace('base + 1 + word','base + 2 + word')),baseline,'offset mutation rejected');
const prefix=fs.readFileSync('wasm/gamepad_snapshot_test.js','utf8').split('// A physical index hole')[0]
  .replace("fs.readFileSync('wasm/platform/gamepad.js', 'utf8')",'source')
  .replace('  Atomics,','  Atomics: trackedAtomics,');
function fixture(source) {
  const out={},counts={stores:0,adds:0};let c;
  const trackedAtomics={...Atomics,store(array,index,value){
    if(index>16&&index<=16+197){assert(Atomics.load(array,16)&1,'payload store inside odd sequence');counts.stores++;}
    return Atomics.store(array,index,value);
  },add(array,index,value){counts.adds++;return Atomics.add(array,index,value);},load:Atomics.load};
  vm.runInNewContext(prefix+`
    output.context=context;output.heap=heap32;output.pad=pad;
    output.setPads=value=>{pads=value;};output.tick=()=>rafCallback();
    output.notifications=()=>notifications;
  `,{require,console,source,output:out,trackedAtomics});
  c=out.context;out.counts=counts;
  out.snapshot=()=>Array.from(out.heap.slice(16,16+198));
  out.reset=()=>{counts.stores=0;counts.adds=0;};
  return out;
}
const a=fixture(current),b=fixture(baseline);
for(const f of [a,b]) {f.heap.fill(1234567,16,214);f.heap[16]=0;f.context.startGamepadSnapshot(false);f.tick();}
assert.deepStrictEqual(a.snapshot(),b.snapshot(),'first publication clears dirty shared memory');
assert.strictEqual(a.counts.stores,197);
a.reset();a.tick();assert.deepStrictEqual(a.counts,{stores:0,adds:0},'idle does not write or wake');
a.pad.axes[0]=0.375;b.pad.axes[0]=0.375;a.reset();b.reset();a.tick();b.tick();
assert.strictEqual(a.counts.stores,1);assert.strictEqual(b.counts.stores,197);
assert.strictEqual(a.counts.adds,2);assert.deepStrictEqual(a.snapshot(),b.snapshot());
// Exact Int32 bits: signed zero, Float32 payloads and arbitrary patterns survive.
let seed=12345;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed|0;};
for(let frame=0;frame<12000;frame++) {
  const count=[0,1,4,42,168,196][frame%6],before=Array.from(a.context._gpNextWords);
  for(let i=0;i<count;i++) {const word=1+((random()>>>0)%196);a.context._gpNextWords[word]=random();}
  a.context._gpNextWords[1+(frame%196)]=[0,-2147483648,0x7fffffff,0x7fc00001][frame%4];
  b.context._gpNextWords.set(a.context._gpNextWords);
  const changed=before.reduce((n,value,i)=>n+(value!==a.context._gpNextWords[i]),0);
  const notifications=a.notifications();a.reset();b.reset();
  a.context._gpPublishIfChanged();b.context._gpPublishIfChanged();
  assert.deepStrictEqual(a.snapshot(),b.snapshot(),'full snapshot matches baseline at '+frame);
  assert.strictEqual(a.counts.stores,changed,'only changed words are stored');
  assert.strictEqual(a.counts.adds,changed?2:0);
  assert.strictEqual(a.notifications()-notifications,changed?1:0);
  assert.deepStrictEqual(Array.from(a.context._gpLastWords),Array.from(a.context._gpNextWords));
}
for(const f of [a,b]) {Atomics.store(f.heap,16,-2);f.context._gpNextWords[10]^=1;f.context._gpPublishIfChanged();}
assert.strictEqual(a.heap[16],0,'sequence wraps without odd residue');assert.deepStrictEqual(a.snapshot(),b.snapshot());
for(const f of [a,b])f.context.stopGamepadSnapshot();
assert.deepStrictEqual(a.snapshot(),b.snapshot());assert(a.snapshot().slice(1).every(v=>v===0),'stop neutralizes every field');
// Real builder: hotplug, sparse browser indices, changing metadata, restart and
// replacement heap views retain the baseline's complete externally visible state.
for(let cycle=0;cycle<40;cycle++) {
  for(const f of [a,b]) {f.context.startGamepadSnapshot(false);f.tick();f.pad.connected=false;f.tick();f.pad.connected=true;f.pad.timestamp++;f.pad.axes=[-0,NaN,Infinity,-0.75];f.tick();
    const replacement=new Int32Array(f.heap.buffer);f.context.Module.HEAP32=replacement;f.tick();}
  assert.deepStrictEqual(a.snapshot(),b.snapshot());
  for(const f of [a,b])f.context.stopGamepadSnapshot();
  assert.deepStrictEqual(a.snapshot(),b.snapshot());
}
async function concurrentReader() {
  const memory=new SharedArrayBuffer(2048),control=new Int32Array(new SharedArrayBuffer(32));
  const publisher=current.slice(current.indexOf('function _gpPublishIfChanged() {'),current.indexOf('\nvar _rumbleEnabled = false;'));
  const state=new Function('memory',`var Module={HEAP32:new Int32Array(memory),_notifyGamepadSnapshot(){}},_gpSnapshotPtr=64,_gpWordCount=197,_gpNextWords=new Int32Array(197),_gpLastWords=new Int32Array(197);_gpLastWords.fill(0x7fffffff);${publisher};return {next:_gpNextWords,publish:_gpPublishIfChanged};`)(memory);
  function publish(generation){state.next[0]=4;state.next[1]=generation;for(let i=2;i<197;i++)state.next[i]=i%3===0?42:generation^i;state.publish();}
  publish(1);
  const worker=new Worker(`const {parentPort,workerData}=require('worker_threads');const heap=new Int32Array(workerData.memory),control=new Int32Array(workerData.control),snapshot=new Int32Array(197);let reads=0,distinct=0,last=0,retries=0;parentPort.postMessage('ready');while(!Atomics.load(control,0)){const before=Atomics.load(heap,16);if(before&1){retries++;continue;}for(let i=0;i<197;i++)snapshot[i]=Atomics.load(heap,17+i);const after=Atomics.load(heap,16);if(before!==after||(after&1)){retries++;continue;}const generation=snapshot[1];if(snapshot[0]!==4)throw Error('bad pad count');for(let i=2;i<197;i++)if(snapshot[i] !== (i%3===0?42:generation^i))throw Error('torn snapshot');reads++;if(generation!==last){distinct++;last=generation;}}parentPort.postMessage({reads,distinct,retries});`,{eval:true,workerData:{memory,control:control.buffer}});
  const failure=new Promise((_,reject)=>worker.once('error',reject));
  await Promise.race([new Promise(resolve=>worker.once('message',resolve)),failure]);
  const result=new Promise(resolve=>worker.once('message',resolve));
  for(let generation=2;generation<=50000;generation++) {publish(generation);if(generation%500===0)await new Promise(resolve=>setImmediate(resolve));}
  Atomics.store(control,0,1);const report=await Promise.race([result,failure]);await worker.terminate();
  assert(report.reads>100&&report.distinct>10&&report.retries>0,'concurrent reader exercised contention');
  console.log('gamepad_publication_test: exact baseline, 197 to 1 stores, 12000 bit patterns, hotplug/stop/restart/wrap and concurrent seqlock reader OK',report);
}
concurrentReader().catch(error=>{console.error(error);process.exitCode=1;});
