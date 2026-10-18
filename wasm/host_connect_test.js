'use strict';
// Production coordinator and parser, deterministic XML/transport fixtures.
const assert=require('assert'),fs=require('fs'),vm=require('vm'),cp=require('child_process');
function query(xml,tag='root') { return {find(n){return query(xml,n);},each(){},
  attr(){const m=xml.match(/status_code="(\d+)"/);return m&&m[1];},
  text(){const m=xml.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>'));return m?m[1]:'';}}; }
function setup() {
  const timers=new Map();let serial=0;
  const c={Promise,navigator:{},isInGame:false,console:{log(){},warn(){},error(){}},
    setTimeout(fn,ms){timers.set(++serial,{fn,ms});return serial;},clearTimeout(id){timers.delete(id);},
    updateHostStatusIndicator(){},updateMacAddress(){}};
  c.window=c;c.$=xml=>query(xml);c.$.parseXML=xml=>xml;vm.createContext(c);
  for(const file of ['wasm/platform/menu-tools.js','wasm/static/js/utils.js'])vm.runInContext(fs.readFileSync(file,'utf8'),c);
  const host=new c.NvHTTP('old.fixture.invalid','fixture','manual.fixture.invalid','12:34:56:78:9A:BC');
  Object.assign(host,{serverUid:'fixture',hostname:'fixture',localAddress:'lan.fixture.invalid',externalIP:'wan.fixture.invalid',
    httpPort:47989,httpsPort:47984,ppkstr:'synthetic pin',paired:true,online:true,_authenticatedOnline:true,
    wakeMacOverride:'12:34:56:78:9A:BC',_memCachedApplist:[{id:1,title:'Saved'}]});
  return {c,host,timers};
}
const info=(name='fixture',uid='fixture',paired='1')=>'<root status_code="200"><uniqueid>'+uid+'</uniqueid><hostname>'+name+'</hostname><PairStatus>'+paired+'</PairStatus><appversion>7.1</appversion><state>SUNSHINE_SERVER_FREE</state></root>';
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
(async()=>{
  let {c,host,timers}=setup(),requests=[],parsers=[];
  const original=c.NvHTTP.prototype._parseServerInfo;
  c.NvHTTP.prototype._parseServerInfo=function(xml,secure){parsers.push(this);return original.call(this,xml,secure);};
  host._parseServerInfo=()=>{throw Error('stale instance parser must not be inherited');};
  const saved=JSON.stringify([host.ppkstr,host.clientUid,host.wakeMacOverride,host._memCachedApplist]);
  c.sendMessage=(name,args)=>{
    assert.strictEqual(name,'openUrlScoped');assert.strictEqual(args[1],host.ppkstr);assert.strictEqual(args[3],4500);
    requests.push(args[0]);return args[0].includes('fixture.local:')?Promise.resolve(info()):Promise.reject(Error('old address'));
  };
  assert.strictEqual(await host.connect(c.createMenuRequestScope()),'fixture.local');
  assert.strictEqual(requests.length,4,'saved IP, LAN, manual, then startup hostname fallback');
  assert(requests.every(s=>s.startsWith('https://')&&s.includes('/serverinfo?')));
  assert(parsers.length===1&&parsers[0]!==host,'fresh instance owns parsed metadata');
  const firstProbe=parsers[0];await host.connect(c.createMenuRequestScope());
  assert.notStrictEqual(parsers.at(-1),firstProbe,'every attempt recreates startup transient state');
  assert.strictEqual(JSON.stringify([host.ppkstr,host.clientUid,host.wakeMacOverride,host._memCachedApplist]),saved);
  assert(!Object.keys(host).includes('_connectionAttempt'));assert(!JSON.stringify(host).includes('_connectionAttempt'));
  assert.strictEqual(timers.size,0);
  // A superseded request settles promptly; an old successful callback cannot
  // change the newer address/name, authentication or cached library.
  let release,cancelled=0;
  c.sendMessage=()=>{const p=new Promise(r=>{release=r;});p.cancel=()=>cancelled++;return p;};
  const before=host.hostname,old=host.connect(c.createMenuRequestScope()).then(()=>false,()=>true);
  c.sendMessage=()=>Promise.resolve(info('new-fixture'));
  await host.connect(c.createMenuRequestScope());assert(await old);assert(cancelled===1);
  release(info('stale-fixture'));await flush();assert.strictEqual(host.hostname,'new-fixture');
  assert(host.online&&host._authenticatedOnline&&host.paired);assert.strictEqual(timers.size,0);
  // Explicit cancellation preserves the last valid connection, has no fallback
  // and does not wait for a missing callback in order to release ownership.
  let scope=c.createMenuRequestScope();requests=[];
  c.sendMessage=(name,args)=>{requests.push(args[0]);const p=new Promise(r=>{release=r;});p.cancel=()=>cancelled++;return p;};
  const pending=host.connect(scope).catch(e=>e.message);scope.cancel();assert.match(await pending,/cancelled/);
  release(info('cancelled-fixture'));await flush();assert.strictEqual(requests.length,1);assert.strictEqual(host.hostname,'new-fixture');
  assert(host._authenticatedOnline);assert.strictEqual(host._connectionAttempt,null);assert.strictEqual(timers.size,0);
  // Failed/partial/foreign/certificate responses never overwrite saved identity
  // or pin, nor silently downgrade to HTTP or launch using a cached app list.
  for(const response of [info('bad','other'),info('bad','fixture','0'),'<root status_code="401"></root>',-100]) {
    c.sendMessage=(name,args)=>{assert(args[0].startsWith('https:'));return typeof response==='number'?Promise.reject(response):Promise.resolve(response);};
    await assert.rejects(host.connect(c.createMenuRequestScope()));
    assert.strictEqual(host.hostname,'new-fixture');assert.strictEqual(host.ppkstr,'synthetic pin');assert(host.paired);
    assert.strictEqual(host._authenticatedOnline,false);assert.strictEqual(host.httpsPort,47984);assert.strictEqual(timers.size,0);
  }
  c.sendMessage=()=>Promise.resolve(info());await host.connect(c.createMenuRequestScope());assert(host._authenticatedOnline);
  // Per-request timeout advances to the next startup candidate; a total bound
  // settles and cancels all outstanding work, without leaving retry machinery.
  c.sendMessage=()=>{const p=new Promise(()=>{});p.cancel=()=>cancelled++;return p;};
  scope=c.createMenuRequestScope();const bounded=host.connect(scope).catch(e=>e.message);
  const per=[...timers].find(([,t])=>t.ms===5000);timers.delete(per[0]);per[1].fn();await flush();
  const total=[...timers].find(([,t])=>t.ms===26000);assert(total);timers.delete(total[0]);total[1].fn();
  assert.match(await bounded,/respond/);assert(!host._authenticatedOnline);assert.strictEqual(timers.size,0);
  c.isInGame=true;let calls=0;c.sendMessage=()=>{calls++;return Promise.resolve(info());};
  await assert.rejects(host.connect(c.createMenuRequestScope()));assert.strictEqual(calls,0);assert.strictEqual(timers.size,0);
  // Freeze all unrelated logic against the preceding candidate, independently
  // of the behavioral fixtures and older release guards.
  const normalize=require('./host-connect-scope.cjs').normalize;
  for(const file of ['wasm/static/js/utils.js','wasm/platform/console-library.js','wasm/platform/index.js']) {
    const source=fs.readFileSync(file,'utf8'),oldSource=cp.execFileSync('git',['show','ed86862:'+file],{encoding:'utf8'});
    assert.strictEqual(normalize(file,source),oldSource,'only bounded menu connection changes: '+file);
    assert.notStrictEqual(normalize(file,source+'\n// unexpected change\n'),oldSource,'unknown edits remain visible');
  }
  const index=fs.readFileSync('wasm/platform/index.js','utf8');
  assert(index.includes('host.connect(scope).then(function() {'),'startup uses the same coordinator');
  const tools=fs.readFileSync('wasm/platform/menu-tools.js','utf8');
  assert.strictEqual(tools,cp.execFileSync('git',['show','ed86862:wasm/platform/menu-tools.js'],{encoding:'utf8'}).replace('    scope.useAppListProbe = true;\n',''));
  console.log('host_connect_test: fresh startup coordinator, full fallback, pinned identity, preserved pairing/cache, supersession, late reply, timeout cleanup, zero gameplay work and exact source scope OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
