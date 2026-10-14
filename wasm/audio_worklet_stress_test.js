'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const seconds=Number(process.env.ML_AUDIO_SECONDS||0);
assert(Number.isFinite(seconds)&&seconds>=0&&seconds<=14400);
for(const rate of [44100,48000,96000]) for(const channels of [1,2,6,8]) {
 let Processor;
 const c={AudioWorkletProcessor:class {constructor(){this.port={postMessage(){}};}},
  registerProcessor(n,p){Processor=p;},sampleRate:rate,Atomics,Int16Array,Int32Array,Math,String};
 vm.runInNewContext(fs.readFileSync('wasm/platform/audio-worklet.js','utf8'),c);
 const capacity=16384,memory=new SharedArrayBuffer(128+capacity*channels*2);
 const control=new Int32Array(memory,0,16),pcm=new Int16Array(memory,128,capacity*channels);
 for(let i=0;i<capacity;i++)for(let ch=0;ch<channels;ch++)pcm[i*channels+ch]=(ch+1)*1000;
 control[2]=7;control[3]=1;control[6]=2048;control[13]=2048;control[14]=4800;
 if(seconds)control[0]=control[9]=-4096;
 const p=new Processor();
 p.port.onmessage({data:{type:'init',memory,controlPtr:0,pcmPtr:128,capacityFrames:capacity,channels,sourceRate:48000,generation:7}});
 const out=Array.from({length:channels+1},()=>new Float32Array(128));
 const quanta=seconds?Math.ceil(seconds*rate/128):500;
 const consumedBefore=Atomics.load(control,9)>>>0;
 for(let quantum=0;quantum<quanta;quantum++){
  Atomics.store(control,1,((Atomics.load(control,0)>>>0)+4096)|0);
  p.process([], [out]);
  for(let ch=0;ch<channels;ch++)for(const value of out[ch])assert(Math.abs(value-(ch+1)*1000/32768)<1e-6);
  assert(out[channels].every(v=>v===0));
 }
 const consumed=((Atomics.load(control,9)>>>0)-consumedBefore)>>>0,expected=quanta*128*48000/rate;
 assert(Math.abs(consumed/expected-1)<0.02,'Resampling must consume the expected source rate');
 // A delayed processor cannot consume samples belonging to another session.
 const read=Atomics.load(control,0);control[2]=8;out[0].fill(1);p.process([], [out]);
 assert(out.every(ch=>ch.every(v=>v===0)));assert.strictEqual(Atomics.load(control,0),read);
 control[2]=7;
 // Repeated starvation cannot push the adaptive target past the selected ceiling.
 for(let i=0;i<30;i++){p.started=true;control[1]=control[0];p.process([], [out]);}
 assert(control[6]<=4800);
 // A stable minute decreases the target without going below its initial value.
 control[1]=control[0]+6000;p.stableOutputFrames=rate*60-128;
 const before=control[6];p.process([], [out]);assert(control[6]<before&&control[6]>=control[13]);
 p.port.onmessage({data:{type:'stop'}});out[0].fill(1);p.process([], [out]);
 assert(out[0].every(v=>v===0));
}
console.log('audio_worklet_stress_test: output rates, channel isolation, drift bounds, generation, target ceiling and recovery OK');
