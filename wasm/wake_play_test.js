'use strict';
// Real menu functions; controlled replies are not a TV/Sunshine emulator.
const assert=require('assert'),fs=require('fs'),cp=require('child_process');
const {fixture}=require('./library_cover_cache_test.js');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function tick(f,ms){const entry=[...f.timers].find(([,t])=>t.ms===ms);assert(entry,'timer '+ms);f.timers.delete(entry[0]);entry[1].fn();await f.flush();}
function setup(){
  const f=fixture(1),c=f.c,h=f.host;
  Object.assign(h,{online:false,paired:true,ppkstr:'synthetic pin',macAddress:'12:34:56:78:9A:BC'});
  f.connects=0;f.wakes=0;f.launches=[];f.audio=0;f.messages=[];f.dialogs=0;
  h.connect=()=>{f.connects++;return f.infoGate?f.infoGate.promise:Promise.reject(Error('offline'));};
  h.sendWOL=()=>{f.wakes++;return f.wakeGate?f.wakeGate.promise:Promise.resolve('sent');};
  c.startGame=(...args)=>{f.launches.push(args);c.isInGame=true;c.ConsoleLibrary.suspend();};
  c.prepareStreamAudio=()=>f.audio++;
  c.snackbarLog=message=>f.messages.push(message);
  c.WakeHost.open=()=>f.dialogs++;
  return f;
}
(async()=>{
  let f=setup();await f.open();
  assert(!f.node('libraryPlay').disabled);assert.strictEqual(f.node('libraryPlay').textContent,'Play');
  assert.strictEqual(f.timers.size,0,'failed initial check never rearms a retry');
  f.node('libraryPlay').click();await f.flush();
  assert.strictEqual(f.launches.length,1,'offline status does not block the manual launcher');
  assert.strictEqual(f.launches[0][1],1);assert.strictEqual(f.launches[0][2],false);
  assert.strictEqual(f.wakes,0);assert.strictEqual(f.audio,0);assert.strictEqual(f.timers.size,0);
  f=setup();f.infoGate=deferred();const opening=f.c.ConsoleLibrary.open(f.host);await f.flush();
  assert.match(f.node('libraryStatus').textContent,/Checking/);assert(!f.node('libraryPlay').disabled);
  f.node('libraryPlay').click();f.infoGate.resolve('late');await opening;await f.flush();
  assert.strictEqual(f.launches.length,1);assert.strictEqual(f.wakes,0);assert.strictEqual(f.timers.size,0);
  // Sending WoL never connects, polls, initializes audio or launches a game.
  f=setup();await f.open();const connects=f.connects;
  f.node('libraryWake').click();await f.flush();
  assert.strictEqual(f.wakes,1);assert.strictEqual(f.connects,connects);
  assert.strictEqual(f.launches.length,0);assert.strictEqual(f.audio,0);assert.strictEqual(f.timers.size,0);
  assert.match(f.node('libraryStatus').textContent,/Wake packet sent/);assert(!f.node('libraryWake').disabled);
  assert.strictEqual(f.host.online,false,'sending is not evidence of readiness');
  // Duplicate packets are suppressed only while the send is pending. Play is not.
  f=setup();await f.open();f.wakeGate=deferred();f.node('libraryWake').click();
  f.node('libraryWake').click();assert.strictEqual(f.wakes,1);assert(!f.node('libraryPlay').disabled);
  f.node('libraryPlay').click();f.wakeGate.resolve('sent');await f.flush();
  assert.strictEqual(f.launches.length,1);assert.strictEqual(f.wakes,1);assert.strictEqual(f.timers.size,0);
  for(const timeout of [false,true]){
    f=setup();await f.open();f.wakeGate=deferred();f.node('libraryWake').click();
    if(timeout)await tick(f,8000);else {f.wakeGate.reject(Error('synthetic failure'));await f.flush();}
    assert.strictEqual(f.launches.length,0);assert.strictEqual(f.connects,1);
    assert.strictEqual(f.timers.size,0);assert(!f.node('libraryWake').disabled);assert(!f.node('libraryPlay').disabled);
    f.wakeGate.resolve('late');await f.flush();assert.strictEqual(f.launches.length,0);
  }
  f=setup();await f.open();f.host.macAddress='';f.node('libraryWake').click();
  assert.strictEqual(f.dialogs,1);assert.strictEqual(f.wakes,0);assert.strictEqual(f.launches.length,0);
  // Reload is one document navigation, cancels work and never clears storage.
  for(const stage of ['serverinfo','covers','wake']){
    f=setup();let work;
    if(stage==='serverinfo'){f.infoGate=deferred();work=f.c.ConsoleLibrary.open(f.host);await f.flush();}
    else {await f.open();if(stage==='covers'){f.host.delay=[];f.c.ConsoleLibrary.invalidateCovers(f.host);work=f.c.ConsoleLibrary.open(f.host);await f.flush();}
      else {f.wakeGate=deferred();f.node('libraryWake').click();}}
    f.storage.set('pairing-fixture','synthetic credentials');const saved=[...f.storage];
    const status=f.node('libraryStatus').textContent,requests=f.calls.length,connects=f.connects;
    for(let i=0;i<10;i++)f.node('libraryRefresh').click();
    assert.strictEqual(f.io.reloads,1);assert.strictEqual(f.timers.size,0);assert.deepStrictEqual([...f.storage],saved);
    if(f.infoGate)f.infoGate.resolve('late');
    if(f.host.delay)f.host.delay.splice(0).forEach(resolve=>resolve('data:image/png;base64,late'));
    if(f.wakeGate)f.wakeGate.resolve('late');
    if(work)await work;await f.flush();
    assert.strictEqual(f.node('libraryStatus').textContent,status);
    assert.strictEqual(f.calls.length,requests);assert.strictEqual(f.connects,connects);assert.strictEqual(f.launches.length,0);
    assert.strictEqual(f.host.ppkstr,'synthetic pin');assert.strictEqual(f.host.paired,true);
  }
  for(const condition of ['hidden','stream']){
    f=setup();await f.open();if(condition==='hidden')f.c.document.hidden=true;else f.c.isInGame=true;
    f.node('libraryRefresh').click();assert.strictEqual(f.io.reloads,0);
  }
  for(const leave of ['settings','suspend','other PC']){
    f=setup();await f.open();f.wakeGate=deferred();f.node('libraryWake').click();
    if(leave==='settings')f.c.ConsoleLibrary.settings();else if(leave==='suspend')f.suspend();
    else {const other={...f.host,serverUid:'other-fixture'};await f.c.ConsoleLibrary.open(other);}
    const status=f.node('libraryStatus').textContent;
    f.wakeGate.resolve('late');await f.flush();assert.strictEqual(f.launches.length,0);
    assert.strictEqual(f.node('libraryStatus').textContent,status);assert.strictEqual(f.timers.size,0);
  }
  for(const file of ['wasm/static/js/utils.js','wasm/main.cpp','wasm/wasmplayer.cpp','wasm/gamepad.cpp',
    'wasm/platform/audio.js','wasm/platform/audio-worklet.js','wasm/platform/gamepad.js',
    'wasm/platform/messages.js','wasm/platform/app-lifecycle.js','wasm/platform/diagnostics.js','wasm/platform/display.js'])
    assert.strictEqual(fs.readFileSync(file,'utf8'),cp.execFileSync('git',['show','v3.4.6:'+file],{encoding:'utf8'}),file+' unchanged');
  const normalize=require('./manual-library-scope.cjs').normalize;
  for(const file of ['wasm/platform/console-library.js','wasm/platform/menu-tools.js','wasm/platform/index.js','wasm/index.html']){
    const source=fs.readFileSync(file,'utf8'),baseline=cp.execFileSync('git',['show','v3.4.6:'+file],{encoding:'utf8'});
    assert.strictEqual(normalize(file,source),baseline,'exact approved menu scope: '+file);
    assert.notStrictEqual(normalize(file,source+'\n// Unknown edit\n'),baseline,'unknown edit remains visible');
  }
  console.log('wake_play_test: independent packet-only Wake, immediate manual Play, one-shot check, document reload, preserved preferences, cancellation, stale replies and frozen media/transport OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
