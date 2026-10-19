'use strict';
// Production coordinator/identity parser with bounded discovery fixtures.
const assert=require('assert'),fs=require('fs'),vm=require('vm');
function query(xml,tag='root'){return {find(n){return query(xml,n);},each(){},
  attr(){const m=xml.match(/status_code="(\d+)"/);return m&&m[1];},
  text(){const m=xml.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>'));return m?m[1]:'';}};}
function setup(saved) {
  const timers=new Map();let next=0;
  const c={Promise,navigator:{},isInGame:false,console:{log(){},warn(){},error(){}},
    setTimeout(fn,ms){timers.set(++next,{fn,ms});return next;},clearTimeout(id){timers.delete(id);}};
  c.window=c;
  c.$=xml=>query(xml);
  c.$.parseXML=xml=>xml;vm.createContext(c);
  for(const file of ['wasm/platform/menu-tools.js','wasm/static/js/utils.js'])vm.runInContext(fs.readFileSync(file,'utf8'),c);
  const h=new c.NvHTTP('old.fixture.invalid','fixture','manual.fixture.invalid');
  Object.assign(h,{hostname:'fixture',serverUid:'fixture-pc',localAddress:'old-lan.fixture.invalid',
    externalIP:'old-wan.fixture.invalid',httpPort:47989,httpsPort:47984,paired:true,
    ppkstr:'synthetic fixture pin',_memCachedApplist:[{id:1,title:'Cached app'}]},saved||{});
  const calls=[],parse=c.NvHTTP.prototype._parseServerInfo;
  c.NvHTTP.prototype._parseServerInfo=function(value,secure) {
    assert(secure);
    if(value!=='verified fixture-pc')return false;
    this._authenticatedOnline=true;this.paired=true;return true;
  };
  c.sendMessage=(method,args)=>{
    assert.strictEqual(method,'openUrlScoped');assert.strictEqual(args[1],h.ppkstr);
    const url=new URL(args[0]);assert.strictEqual(url.protocol,'https:');
    calls.push(url.hostname);
    return url.hostname==='new.fixture.invalid'?Promise.resolve('verified fixture-pc'):Promise.reject(Error('Saved endpoint unavailable'));
  };
  return {c,h,calls,timers,parse};
}
function enabled(){
  const f=setup();f.c.NvHTTP.prototype._parseServerInfo=f.parse;
  f.c.Module={discoverHosts(){}};
  f.c.webapis={network:{getIp(){return '192.0.2.12';},getSubnetMask(){return '255.255.255.128';}}};
  return f;
}
const info=uid=>'<root status_code="200"><uniqueid>'+uid+'</uniqueid><hostname>fixture</hostname><PairStatus>1</PairStatus><appversion>7.1</appversion><state>SUNSHINE_SERVER_FREE</state></root>';
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
(async()=>{
  const f=setup(),saved=JSON.parse(JSON.stringify(f.h));
  for(let i=0;i<4;i++)await assert.rejects(f.h.connect(f.c.createMenuRequestScope()));
  assert.strictEqual(f.calls.length,20,'four rounds retry the same five saved candidates');
  assert(!f.calls.includes('new.fixture.invalid'),'no discovery of the available but unknown address');
  assert(f.h.paired&&f.h.ppkstr===saved.ppkstr);assert.strictEqual(f.h._memCachedApplist[0].id,1);
  assert.strictEqual(f.timers.size,0);
  // Reloading only these unchanged saved addresses cannot fix an actual DHCP
  // address change. A different physical restart outcome needs another cause.
  const restarted=setup(saved);
  await assert.rejects(restarted.h.connect(restarted.c.createMenuRequestScope()));
  assert.deepStrictEqual(restarted.calls,f.calls.slice(0,5));
  // The current connector does recover when supplied with a valid new address:
  // the missing mechanism is obtaining it, not accepting it after TLS proof.
  f.h.address='new.fixture.invalid';
  assert.strictEqual(await f.h.connect(f.c.createMenuRequestScope()),'new.fixture.invalid');
  assert(f.h.online&&f.h._authenticatedOnline&&f.h.paired);assert.strictEqual(f.timers.size,0);
  const index=fs.readFileSync('wasm/platform/index.js','utf8');
  const start=index.indexOf('// Known PCs need no subnet-wide scan');
  assert(start>=0);
  const startup=index.slice(start,index.indexOf('\n      });',start));
  assert(startup.includes('Object.keys(hosts).length')&&startup.includes('startSubnetScanner()'));
  const library=fs.readFileSync('wasm/platform/console-library.js','utf8');
  assert(library.slice(library.indexOf('  function open(pc)')).includes('stopSubnetScanner()'));
  // Healthy first route incurs no discovery, extra request, timer or network API.
  let g=enabled(),discoveryCalls=0,https=[];
  g.c.webapis.network.getIp=()=>{throw Error('must not query TV network');};
  g.c.sendMessage=(method,args)=>{assert.strictEqual(method,'openUrlScoped');return Promise.resolve(info('fixture-pc'));};
  await g.h.connect(g.c.createMenuRequestScope());assert.strictEqual(g.timers.size,0);
  // New address is only adopted after the real pinned HTTPS/UUID parser accepts
  // it. mDNS/native hints, malformed data and foreign identities are not proof.
  g=enabled();
  g.c.sendMessage=(method,args)=>{
    if(method==='discoverHosts'){
      discoveryCalls++;assert.deepStrictEqual(Array.from(args),['192.0.2.12','255.255.255.128','old-lan.fixture.invalid',47984,0]);
      return Promise.resolve(JSON.stringify({cursor:32,addresses:['192.0.2.75','192.0.2.76']}));
    }
    assert.strictEqual(method,'openUrlScoped');assert.strictEqual(args[1],g.h.ppkstr);
    assert(args[0].startsWith('https:'));const ip=new URL(args[0]).hostname;https.push(ip);
    if(ip==='192.0.2.75')return Promise.resolve(info('other-pc'));
    return ip==='192.0.2.76'?Promise.resolve(info('fixture-pc')):Promise.reject(Error('old route'));
  };
  const credentials=JSON.stringify([g.h.ppkstr,g.h.serverUid,g.h.clientUid,g.h._memCachedApplist]);
  assert.strictEqual(await g.h.connect(g.c.createMenuRequestScope()),'192.0.2.76');
  assert.strictEqual(discoveryCalls,1);assert.strictEqual(https.length,7);assert(g.h.online&&g.h._authenticatedOnline);
  assert.strictEqual(JSON.stringify([g.h.ppkstr,g.h.serverUid,g.h.clientUid,g.h._memCachedApplist]),credentials);
  assert(!JSON.stringify(g.h).includes('_rediscovery'));assert.strictEqual(g.h._rediscovery.cursor,32);assert.strictEqual(g.timers.size,0);
  // A known fallback wins without waiting for discovery; cancellation retires
  // the native request and a stale reply cannot advance the runtime cursor.
  g=enabled();let late,cancelled=0;
  g.c.sendMessage=(method,args)=>{
    if(method==='discoverHosts'){const p=new Promise(r=>{late=r;});p.cancel=()=>cancelled++;return p;}
    return args[0].includes('old-lan.')?Promise.resolve(info('fixture-pc')):Promise.reject(Error('stale'));
  };
  assert.strictEqual(await g.h.connect(g.c.createMenuRequestScope()),'old-lan.fixture.invalid');
  assert.strictEqual(cancelled,1);late(JSON.stringify({cursor:999,addresses:['192.0.2.76']}));await flush();
  assert.strictEqual(g.h._rediscovery.cursor,0);assert.strictEqual(g.timers.size,0);
  // Cursor advances between bounded rounds, resets on a real TV network change,
  // and never lets a hint outside that network become a probe.
  g=enabled();let cursors=[];
  g.c.sendMessage=(method,args)=>{
    if(method==='discoverHosts'){cursors.push(args[4]);return Promise.resolve(JSON.stringify({cursor:32+args[4],addresses:['192.0.2.200','192.0.2.12','127.0.0.1','not-an-ip']}));}
    assert(!args[0].includes('192.0.2.200'));return Promise.reject(Error('offline'));
  };
  for(let i=0;i<2;i++)await assert.rejects(g.h.connect(g.c.createMenuRequestScope()));
  g.c.webapis.network.getSubnetMask=()=> '255.255.255.0';
  await assert.rejects(g.h.connect(g.c.createMenuRequestScope()));assert.deepStrictEqual(cursors,[0,32,0]);
  // Wrong certificate/UUID, malformed result or no pairing cannot promote a PC.
  for(const response of [-100,info('foreign-pc')]){
    g=enabled();g.c.sendMessage=(method,args)=>method==='discoverHosts'?Promise.resolve('{"cursor":2,"addresses":["192.0.2.76"]}'):
      args[0].includes('192.0.2.76')?(response===-100?Promise.reject(-100):Promise.resolve(response)):Promise.reject(Error('offline'));
    await assert.rejects(g.h.connect(g.c.createMenuRequestScope()));assert.strictEqual(g.h.address,'old.fixture.invalid');assert(g.h.paired);
  }
  for(const malformed of ['not-json','null','{"cursor":-1,"addresses":[]}',JSON.stringify({cursor:0,addresses:Array(9).fill('192.0.2.76')})]){
    g=enabled();g.c.sendMessage=(method)=>method==='discoverHosts'?Promise.resolve(malformed):Promise.reject(Error('offline'));
    await assert.rejects(g.h.connect(g.c.createMenuRequestScope()));assert.strictEqual(g.timers.size,0);
  }
  for(const key of ['ppkstr','serverUid','paired']){
    g=enabled();g.h[key]=null;g.c.sendMessage=method=>{assert.notStrictEqual(method,'discoverHosts');return Promise.reject(Error('offline'));};
    await assert.rejects(g.h.connect(g.c.createMenuRequestScope()));
  }
  // Cancellation/game transition suppress further traffic and late metadata.
  g=enabled();let release;
  g.c.sendMessage=method=>{if(method!=='discoverHosts')return Promise.reject(Error('offline'));
    const p=new Promise(r=>{release=r;});p.cancel=()=>cancelled++;return p;};
  const scope=g.c.createMenuRequestScope(),pending=g.h.connect(scope).catch(()=>{});await flush();scope.cancel();await pending;
  release('{"cursor":99,"addresses":["192.0.2.76"]}');await flush();assert.strictEqual(g.h._rediscovery.cursor,0);assert.strictEqual(g.timers.size,0);
  g.c.isInGame=true;g.c.sendMessage=()=>{throw Error('no gameplay traffic');};await assert.rejects(g.h.connect(g.c.createMenuRequestScope()));
  // Exercise the actual JS/native bridge rather than only sendMessage doubles.
  const bridge={console,Module:{},Error};vm.createContext(bridge);
  vm.runInContext(fs.readFileSync('wasm/platform/messages.js','utf8'),bridge);
  let id,bridgeCancels=0;
  bridge.Module.discoverHosts=(callbackId,...args)=>{id=callbackId;assert.strictEqual(args[3],47984);};
  bridge.Module.cancelMenuRequest=callbackId=>{assert.strictEqual(callbackId,id);bridgeCancels++;bridge.handlePromiseMessage(id,'resolve','late');};
  const raw=bridge.sendMessage('discoverHosts',['192.0.2.12','255.255.255.128','192.0.2.11',47984,0]);
  const rejected=raw.catch(e=>e.message);raw.cancel();assert.match(await rejected,/cancelled/);assert.strictEqual(bridgeCancels,1);
  assert.strictEqual(Object.keys(bridge.callbacks).length,0);
  const reply=bridge.sendMessage('discoverHosts',['192.0.2.12','255.255.255.128','192.0.2.11',47984,0]);
  bridge.handlePromiseMessage(id,'resolve','{"cursor":32,"addresses":[]}');assert.strictEqual(await reply,'{"cursor":32,"addresses":[]}');
  console.log('host_discovery_test: verified address recovery, known-route priority, real identity parser, cursor/CIDR, pin/UUID rejection, cancellation, private runtime state and no gameplay work passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
