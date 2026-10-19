'use strict';
// Reproduction of missing-address recovery, not a fix or physical DHCP proof.
const assert=require('assert'),fs=require('fs'),vm=require('vm');
function setup(saved) {
  const timers=new Map();let next=0;
  const c={Promise,navigator:{},isInGame:false,console:{log(){},warn(){},error(){}},
    setTimeout(fn,ms){timers.set(++next,{fn,ms});return next;},clearTimeout(id){timers.delete(id);}};
  c.window=c;vm.createContext(c);
  for(const file of ['wasm/platform/menu-tools.js','wasm/static/js/utils.js'])vm.runInContext(fs.readFileSync(file,'utf8'),c);
  const h=new c.NvHTTP('old.fixture.invalid','fixture','manual.fixture.invalid');
  Object.assign(h,{hostname:'fixture',serverUid:'fixture-pc',localAddress:'old-lan.fixture.invalid',
    externalIP:'old-wan.fixture.invalid',httpPort:47989,httpsPort:47984,paired:true,
    ppkstr:'synthetic fixture pin',_memCachedApplist:[{id:1,title:'Cached app'}]},saved||{});
  const calls=[];
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
  return {c,h,calls,timers};
}
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
  console.log('host_discovery_test: REPRODUCED unknown-address recovery gap; retries and same-address reload cannot discover it; supplied verified address succeeds. Existing connector unchanged.');
})().catch(error=>{console.error(error);process.exitCode=1;});
