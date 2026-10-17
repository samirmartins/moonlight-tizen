'use strict';
// Compare real render/servo code with the published baseline, sample for sample.
const assert=require('assert'),fs=require('fs'),vm=require('vm'),cp=require('child_process');
const baseline=file=>cp.execFileSync('git',['show','v3.4.3:'+file],{encoding:'utf8'});
const audio='wasm/platform/audio.js',worklet='wasm/platform/audio-worklet.js';
const currentAudio=fs.readFileSync(audio,'utf8'),oldAudio=baseline(audio);
const currentWorklet=fs.readFileSync(worklet,'utf8'),oldWorklet=baseline(worklet);
function trackedAtomics() {
  const calls={depth:0,loads:0};
  const api={};
  for(const name of ['load','store','add','compareExchange']) api[name]=function(...args){
    if(name==='load')calls.loads++;
    if(args[1]===7 || args[1]===8)calls.depth++;
    return Atomics[name](...args);
  };
  return {api,calls};
}
function ring(channels,mode) {
  const capacity=16384,memory=new SharedArrayBuffer(128+capacity*channels*2);
  const control=new Int32Array(memory,0,16),pcm=new Int16Array(memory,128,capacity*channels);
  for(let i=0;i<capacity;i++)for(let ch=0;ch<channels;ch++)pcm[i*channels+ch]=((i*97+ch*997)%60000)-30000;
  control[0]=control[9]=-4096;control[2]=7;control[3]=mode;control[6]=control[13]=2048;control[14]=4800;control[7]=-1;
  return {capacity,memory,control,pcm};
}
function processor(source,rate,channels,enabled) {
  let Processor;
  const tracked=trackedAtomics(),r=ring(channels,1);
  vm.runInNewContext(source,{AudioWorkletProcessor:class{constructor(){this.port={postMessage(){}};}},
    registerProcessor(name,type){Processor=type;},sampleRate:rate,Atomics:tracked.api});
  const p=new Processor();
  p.port.onmessage({data:{type:'init',memory:r.memory,controlPtr:0,pcmPtr:128,
    capacityFrames:r.capacity,channels,sourceRate:48000,generation:7,telemetry:enabled}});
  return {...r,p,calls:tracked.calls,out:Array.from({length:channels+1},()=>new Float32Array(128))};
}
function sameOutput(a,b) {
  a.forEach((channel,i)=>assert.deepStrictEqual(new Uint32Array(channel.buffer),new Uint32Array(b[i].buffer),'exact Float32 output bits'));
}
function sameControl(a,b) {
  for(let i=0;i<16;i++)if(i!==7 && i!==8)assert.strictEqual(a[i],b[i],'functional control word '+i);
}
function prepare(a,b,q) {
  for(const c of [a.control,b.control]) {
    if(q && q%137===0){c[0]=(c[0]+1000)|0;c[12]++;}
    c[1]=(c[0]+(q%43===0?1:4096))|0;c[10]=(q%11-5)*400;
    c[2]=q===451?8:7;
  }
}
for(const rate of [44100,48000,96000])for(const channels of [1,2,6,8])for(const alwaysOn of [false,true]) {
  const old=processor(oldWorklet,rate,channels,true),now=processor(currentWorklet,rate,channels,alwaysOn);
  let enabled=alwaysOn;
  for(let q=0;q<512;q++) {
    if(!alwaysOn && [80,160,240,320,400].includes(q)) {
      enabled=!enabled;now.p.port.onmessage({data:{type:'telemetry',generation:7,enabled}});
    }
    if(!alwaysOn && q===200) {
      now.p.port.onmessage({data:{type:'telemetry',generation:99,enabled:true}});
      assert.strictEqual(now.p.noteDepth,now.p.ignoreDepth,'stale telemetry transition ignored');
    }
    prepare(old,now,q);
    if(q===401)old.p.stableOutputFrames=now.p.stableOutputFrames=rate*60-128;
    const before=now.calls.depth,countdown=now.p.statsCountdown;
    old.p.process([], [old.out]);now.p.process([], [now.out]);
    sameOutput(old.out,now.out);sameControl(old.control,now.control);
    for(const field of ['readFrame','phase','epoch','started','stableOutputFrames'])assert.strictEqual(now.p[field],old.p[field],field);
    if(!enabled){assert.strictEqual(now.calls.depth,before,'OFF performs no min/max atomics');assert.strictEqual(now.p.statsCountdown,countdown,'OFF performs no sampling countdown');}
    if(alwaysOn){assert.strictEqual(now.control[7],old.control[7]);assert.strictEqual(now.control[8],old.control[8]);}
  }
  assert(now.calls.depth>0,'ON collection remains active');
  now.p.port.onmessage({data:{type:'stop'}});
  now.p.port.onmessage({data:{type:'telemetry',generation:7,enabled:true}});
  const read=now.control[0];now.out.forEach(channel=>channel.fill(1));now.p.process([], [now.out]);
  assert(now.out.every(channel=>channel.every(value=>value===0)));assert.strictEqual(now.control[0],read);
}
function scheduler(source,channels=2) {
  const r=ring(channels,2),tracked=trackedAtomics();
  const c={console,window:{},Module:{HEAP32:new Int32Array(r.memory),HEAP16:new Int16Array(r.memory)},
    performance:{now:()=>1000},Atomics:tracked.api};
  vm.createContext(c);vm.runInContext(source,c);
  c._audControl=r.control;c._audPcm=r.pcm;c._audCapacityFrames=r.capacity;
  c._audGeneration=7;c._audChannels=channels;c._audSourceRate=48000;
  c._audFallbackReadFrame=r.control[0]>>>0;c._audResetStats();
  return {...r,c,calls:tracked.calls};
}
for(const rate of [44100,48000,96000])for(const channels of [1,2,6,8]) {
  const old=scheduler(oldAudio,channels),now=scheduler(currentAudio,channels);
  const a=Array.from({length:channels+1},()=>new Float32Array(1024)),b=a.map(()=>new Float32Array(1024));
  const output=channelsData=>({length:1024,sampleRate:rate,numberOfChannels:channelsData.length,getChannelData:i=>channelsData[i]});
  for(let q=0;q<100;q++) {
    if(q===20)now.c.setAudioTelemetryEnabled('diagnostics',true);
    if(q===40)now.c.setAudioTelemetryEnabled('overlay',true);
    if(q===60)now.c.setAudioTelemetryEnabled('diagnostics',false);
    if(q===80)now.c.setAudioTelemetryEnabled('overlay',false);
    prepare(old,now,q);
    if(q===85)old.c._audFallbackStableFrames=now.c._audFallbackStableFrames=rate*60-1024;
    const before=now.calls.depth,countdown=now.c._audFallbackStatsCountdown;
    old.c._audProcessFallback({outputBuffer:output(a)});now.c._audProcessFallback({outputBuffer:output(b)});
    sameOutput(a,b);sameControl(old.control,now.control);
    for(const field of ['_audFallbackReadFrame','_audFallbackPhase','_audFallbackEpoch','_audFallbackStarted','_audFallbackStableFrames'])assert.strictEqual(now.c[field],old.c[field],field);
    if(q<20 || q>=80){assert.strictEqual(now.calls.depth,before);assert.strictEqual(now.c._audFallbackStatsCountdown,countdown);}
  }
  assert(now.calls.depth>0);
}
// Removing background stats must preserve every drift branch and visible output.
{
  const old=scheduler(oldAudio),now=scheduler(currentAudio);
  for(let i=0;i<32;i++) {
    for(const c of [old.control,now.control]){c[9]=48000*(i+1);c[11]=i===29?0:1;if(i===17)c[4]++;}
    const position=(i+1)*1000+(i>=10 && i<=14?400:i%8<4?7:-9);
    old.c.publishPipelinePosition(position);now.c.publishPipelinePosition(position);
    sameControl(old.control,now.control);
    for(const field of ['_audPipelinePositionS','_audPipelineAtMs','_audDriftEpochOffset','_audDriftEpochInitialized','_audDriftFiltered','_audDriftOutliers','_audLastUnderruns'])assert.strictEqual(now.c[field],old.c[field],field);
    assert.strictEqual(now.c.getAudioTelemetryLine(),old.c.getAudioTelemetryLine(),'same overlay audio line on demand');
  }
  const a=scheduler(oldAudio),b=scheduler(currentAudio);
  for(const s of [a,b]){s.control[9]=48000;s.control[11]=1;s.c._audDriftEpochInitialized=true;}
  let prior=a.calls.loads;a.c.publishPipelinePosition(1000);const oldLoads=a.calls.loads-prior;
  prior=b.calls.loads;b.c.publishPipelinePosition(1000);const newLoads=b.calls.loads-prior;
  assert.strictEqual(oldLoads,23);assert.strictEqual(newLoads,3);
}
// Real consumer lifecycle hooks, including both consumers and unsupported rVFC.
{
  const s=scheduler(currentAudio),c=s.c,nodes={diagnosticsSwitch:{checked:false},wasm_module:{}};
  c.document={getElementById:id=>nodes[id]||(nodes[id]={checked:false})};
  c.isInGame=true;c.appInfo={version:'fixture'};c.modelName='Fixture';c.platformVer='9.0';
  c.localStorage={setItem(){},getItem(){return null;}};c.snackbarLogLong=()=>{};c.clearTimeout=()=>{};
  c.Module.setDiagnostics=()=>{};
  c.XMLHttpRequest=function(){this.open=()=>{};this.send=()=>{};this.abort=()=>{};};
  const messages=[];c._audWorkletNode={port:{postMessage:data=>messages.push(data)}};
  vm.runInContext(fs.readFileSync('wasm/platform/display.js','utf8'),c);
  vm.runInContext(fs.readFileSync('wasm/platform/diagnostics.js','utf8'),c);
  c.SessionDiagnostics.start();assert.strictEqual(c._audTelemetryMask,0);
  c.startVideoPresentationObserver({});assert.strictEqual(c._audTelemetryMask,1);
  nodes.diagnosticsSwitch.checked=true;c.SessionDiagnostics.start();assert.strictEqual(c._audTelemetryMask,3);
  c.stopVideoPresentationObserver();assert.strictEqual(c._audTelemetryMask,2);
  c.SessionDiagnostics.finish('Fixture');assert.strictEqual(c._audTelemetryMask,0);
  assert.deepStrictEqual(messages.map(m=>[m.type,m.generation,m.enabled]),[['telemetry',7,true],['telemetry',7,false]]);
  c.setAudioTelemetryEnabled('invalid',true);c.setAudioTelemetryEnabled('overlay',false);assert.strictEqual(messages.length,2);
  c._audWorkletNode.port.postMessage=()=>{throw Error('Fixture port closed');};
  assert.doesNotThrow(()=>c.setAudioTelemetryEnabled('overlay',true),'optional port failure must not break sound');
}
require('./audio-telemetry-scope.cjs').assertFrozen('v3.4.3',require('./audio-telemetry-scope.cjs').files);
console.log('audio_telemetry_test: 24 worklet/12 fallback sample-exact cases, OFF min/max idle, ON stats, mixed/stale consumer transitions, unchanged drift/overlay and 23 -> 3 clock loads OK');
