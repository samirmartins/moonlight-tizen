'use strict';
// Production library + NvHTTP; deterministic boot replies and clock, no PC/TV.
const assert=require('assert'),fs=require('fs'),cp=require('child_process');
const {fixture}=require('./library_cover_cache_test.js');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function tick(f,ms){const entry=[...f.timers].find(([,t])=>t.ms===ms);assert(entry,'timer '+ms);f.timers.delete(entry[0]);entry[1].fn();await f.flush();}
function setup() {
  const f=fixture(1),c=f.c,h=f.host;
  delete h.connect;delete h.getAppListWithCacheFlush;
  Object.setPrototypeOf(h,c.NvHTTP.prototype);
  Object.assign(h,{address:'fixture.invalid',hostname:'fixture',httpsPort:47984,httpPort:47989,
    ppkstr:'synthetic pin',clientUid:'fixture',paired:true,online:false,_authenticatedOnline:false,
    macAddress:'12:34:56:78:9A:BC'});
  Object.defineProperty(h,'_availabilityCursor',{value:0,writable:true});
  f.phase='off';f.requests=[];f.launches=[];f.wakes=0;f.audio=0;f.closed=0;f.cancelled=0;
  h._parseAppList=xml=>{assert.strictEqual(xml,'fresh list');return f.fresh||[{id:1,title:'Fresh game'}];};
  h._parseServerInfo=(xml,secure)=>{assert(secure);if(xml!=='ready')return false;h._authenticatedOnline=true;return true;};
  c.prepareStreamAudio=()=>f.audio++;
  c.stopAudioScheduler=()=>f.closed++;
  c.startGame=(...args)=>{f.launches.push(args);c.isInGame=true;c.ConsoleLibrary.suspend();};
  h.sendWOL=()=>{f.wakes++;return f.wakeGate?f.wakeGate.promise:Promise.resolve('sent');};
  c.sendMessage=(kind,args)=>{
    assert.strictEqual(kind,'openUrlScoped');assert(args[0].startsWith('https://'));assert.strictEqual(args[1],h.ppkstr);
    f.requests.push(args[0]);
    const app=args[0].includes('/applist?');
    if(app&&f.listGate){const p=f.listGate.promise;p.cancel=()=>f.cancelled++;return p;}
    if(!app&&f.infoGate){const p=f.infoGate.promise;p.cancel=()=>f.cancelled++;return p;}
    if(f.phase==='off')return Promise.reject(Error('booting'));
    return app?Promise.resolve('fresh list'):f.phase==='on'?Promise.resolve('ready'):Promise.reject(Error('metadata still booting'));
  };
  return f;
}
(async()=>{
  let f=setup();await f.open();f.node('libraryPlay').click();await f.flush();
  assert.strictEqual(f.wakes,1);assert.strictEqual(f.audio,1);assert(!f.launches.length);
  assert([...f.timers.values()].some(t=>t.ms===120000));
  f.phase='list';await tick(f,2000);assert(!f.launches.length,'list alone cannot complete launch preparation');
  assert(f.requests.some(s=>s.includes('/serverinfo?')));assert(!f.node('libraryCancel').hidden);
  f.phase='on';await tick(f,2000);
  assert.strictEqual(f.launches.length,1);assert.strictEqual(f.launches[0][1],1);
  assert.strictEqual(f.launches[0][2],true);assert.strictEqual(f.launches[0].length,3,'same manual launcher signature');
  assert.strictEqual(f.host._memCachedApplist[0].title,'Fresh game','old cache cannot replace new list');
  assert.strictEqual(f.wakes,1);assert.strictEqual(f.audio,1);assert.strictEqual(f.closed,0);
  assert.strictEqual(f.timers.size,0,'ready immediately; no wait to 120 s and no gameplay polling');
  // A slow/unresolved disk cover must never stop the next discovery round or
  // block handoff after valid network replies. This reproduces the prior gate.
  for(const phase of ['off','list']) {
    f=setup();await f.open();f.c.ConsoleLibrary.invalidateCovers(f.host);f.host.delay=[];f.phase=phase;
    f.node('libraryPlay').click();await f.flush();
    assert(f.host.delay.length>0,'cover fixture must remain unresolved');
    assert([...f.timers.values()].some(t=>t.ms===2000),'pending cover cannot prevent wake retry');
    assert.match(f.node('libraryStatus').textContent,/retrying/,'wake retries must be visible');
    f.phase='on';await tick(f,2000);
    assert.strictEqual(f.launches.length,1,'ready PC launches before disk cover resolves');
    assert.strictEqual(f.timers.size,0);const requests=f.requests.length;
    f.host.delay.splice(0).forEach(resolve=>resolve('data:image/png;base64,late-cover'));await f.flush();
    assert.strictEqual(f.requests.length,requests);assert.strictEqual(f.node('game-grid').children.length,0);
  }
  // An unreachable saved address/first fallback is followed by a different
  // fallback on retry; do not discard candidates or accept cached online state.
  f=setup();await f.open();f.host.localAddress='old-lan.fixture.invalid';
  f.host.userEnteredAddress='ready.fixture.invalid';f.phase='on';
  const send=f.c.sendMessage;
  f.c.sendMessage=(kind,args)=>{
    if(!args[0].startsWith('https://ready.fixture.invalid:')){
      f.requests.push(args[0]);return Promise.reject(Error('stale address'));
    }
    return send(kind,args);
  };
  f.node('libraryPlay').click();await f.flush();assert(!f.launches.length);
  assert(f.requests.some(url=>url.includes('old-lan.fixture.invalid')));
  await tick(f,2000);assert.strictEqual(f.launches.length,1);
  assert.strictEqual(f.host.address,'ready.fixture.invalid');assert.strictEqual(f.wakes,1);
  // Library retries change their epoch, but must retain the same bounded user
  // intent across many offline rounds without resending WoL or resetting time.
  f=setup();await f.open();f.node('libraryPlay').click();await f.flush();
  const deadline=[...f.timers].find(([,t])=>t.ms===120000)[0];
  for(let i=0;i<12;i++)await tick(f,2000);
  assert(f.timers.has(deadline));assert.strictEqual(f.wakes,1);assert.strictEqual(f.audio,1);
  f.phase='on';await tick(f,2000);assert.strictEqual(f.launches.length,1);assert.strictEqual(f.timers.size,0);
  // Leaving for settings/another PC clears intent; a late old reply cannot
  // take over the new view or launch against the wrong host.
  for(const leave of ['settings','other PC']) {
    f=setup();await f.open();f.phase='on';f.listGate=deferred();
    f.node('libraryPlay').click();await f.flush();
    if(leave==='settings')f.c.ConsoleLibrary.settings();
    else {
      const other={...f.host,serverUid:'other-fixture',online:true,_authenticatedOnline:true,connect:()=>Promise.resolve(),
        getAppListWithCacheFlush:()=>Promise.resolve([{id:1,title:'Other PC app'}])};
      f.c.hosts[other.serverUid]=other;await f.c.ConsoleLibrary.open(other);
    }
    f.listGate.resolve('fresh list');await f.flush();assert(!f.launches.length);assert.strictEqual(f.timers.size,0);
    f.suspend();
  }
  // Delayed WoL delivery is not charged to the boot budget.
  f=setup();await f.open();f.wakeGate=deferred();f.node('libraryPlay').click();await f.flush();
  assert(![...f.timers.values()].some(t=>t.ms===120000));
  f.wakeGate.resolve('sent');await f.flush();assert([...f.timers.values()].some(t=>t.ms===120000));
  f.node('libraryCancel').click();assert.strictEqual(f.timers.size,0);
  // Cancellation/timeout/visibility prevents late authenticated replies from
  // changing status, entering a game or leaving work behind.
  for(const stage of ['list','metadata'])for(const action of ['cancel','deadline','suspend']) {
    f=setup();await f.open();const gate=deferred();f.phase='on';
    if(stage==='list')f.listGate=gate;else f.infoGate=gate;
    f.node('libraryPlay').click();await f.flush();assert(!f.launches.length);
    if(action==='cancel')f.node('libraryCancel').click();
    else if(action==='deadline')await tick(f,120000);
    else f.suspend();
    const status=f.node('libraryStatus').textContent;
    gate.resolve(stage==='list'?'fresh list':'ready');await f.flush();
    assert(!f.launches.length);assert.strictEqual(f.node('libraryStatus').textContent,status);
    assert.strictEqual(f.timers.size,0);assert(f.cancelled>0,'cancel native request too');
    if(action==='deadline'){assert.match(status,/120 s/);assert(!f.node('libraryPlay').disabled);assert(f.closed>0);}
  }
  // Missing callbacks have a per-round bound and cannot overlap retries.
  f=setup();await f.open();f.phase='on';const gate=deferred();f.listGate=gate;
  f.node('libraryPlay').click();await f.flush();await tick(f,3500);
  // The hostname fallback is also bounded; force the outer round deadline.
  await tick(f,8000);assert(f.cancelled>0);const count=f.requests.length;
  gate.resolve('fresh list');await f.flush();assert(!f.launches.length);assert.strictEqual(f.requests.length,count);
  delete f.listGate;await tick(f,2000);assert.strictEqual(f.launches.length,1);assert.strictEqual(f.timers.size,0);
  // Valid empty or changed boot lists are not a cached-app launch permission.
  f=setup();await f.open();f.phase='on';f.fresh=[];f.node('libraryPlay').click();await f.flush();
  assert(!f.launches.length);assert.match(f.node('libraryStatus').textContent,/selected app/);
  f.fresh=[{id:2,title:'Other app'}];await tick(f,2000);assert(!f.launches.length);
  f.fresh=[{id:1,title:'Ready app'}];await tick(f,2000);assert.strictEqual(f.launches.length,1);
  assert.strictEqual(f.host._memCachedApplist[0].title,'Ready app');assert.strictEqual(f.timers.size,0);
  // Security failure stops safely; no downgrade, implicit re-pair or launch.
  f=setup();await f.open();f.phase='on';f.c.sendMessage=(kind,args)=>args[0].includes('/applist?')?Promise.resolve('fresh list'):Promise.reject(-100);
  f.node('libraryPlay').click();await f.flush();assert(!f.host.paired);assert(!f.launches.length);assert.match(f.node('libraryStatus').textContent,/pairing/);assert.strictEqual(f.timers.size,0);
  // Byte-for-byte scope guard: only the boot path and prepared-info handoff
  // may differ from the otherwise TV-validated candidate.
  const normalize=require('./wake-play-scope.cjs').normalize;
  for(const file of ['wasm/platform/console-library.js','wasm/platform/index.js']) {
    const old=cp.execFileSync('git',['show','f5ccf2a:'+file],{encoding:'utf8'});
    assert.strictEqual(normalize(file,fs.readFileSync(file,'utf8')),old,file+' isolated wake changes');
  }
  const library=fs.readFileSync('wasm/platform/console-library.js','utf8');
  const wake=library.slice(library.indexOf('  function play('),library.indexOf('  function bind('));
  assert(!wake.includes('connect(')&&!wake.includes('function check('),'wake has no private discovery loop');
  assert(wake.includes('refresh(false,true)'),'normal library refresh owns discovery');
  assert.strictEqual(fs.readFileSync('wasm/platform/index.js','utf8'),cp.execFileSync('git',['show','f5ccf2a:wasm/platform/index.js'],{encoding:'utf8'}),'manual launcher restored exactly');
  console.log('wake_play_test: normal library discovery owns wake intent, staged readiness, fresh lists, immediate single manual launch, 120s bound, cancellation, late replies, missing app and pin failure OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
