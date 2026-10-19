'use strict';
// Production classifier and shared snapshot; IDs below are synthetic fixtures.
const assert=require('assert'),fs=require('fs'),vm=require('vm'),cp=require('child_process');
const file='wasm/platform/gamepad.js',source=fs.readFileSync(file,'utf8');
const before=cp.execFileSync('git',['show','f89c0bb:'+file],{encoding:'utf8'});
const prefix=fs.readFileSync('wasm/gamepad_snapshot_test.js','utf8').split('// A physical index hole')[0]
  .replace("fs.readFileSync('wasm/platform/gamepad.js', 'utf8')",'source');
function fixture(source) {
 const out={};
 vm.runInNewContext(prefix+`
   output.c=context;output.pad=pad;output.heap=heap32;
   output.setPads=value=>{pads=value;};output.tick=()=>rafCallback();
   output.emit=(name,gamepad)=>listeners[name].forEach(fn=>fn({gamepad}));
 `,{require,console,source,output:out});
 return out;
}
const current=fixture(source),old=fixture(before);
const type=id=>current.c._gpControllerType({id});
const cases=[
 ['Sony DualSense Wireless Controller',2],['DUALSHOCK',2],['PlayStation Controller',2],['Sony Controller',2],
 ['Xbox Wireless Controller',1],['XINPUT Controller',1],['X-Box Controller',1],['Microsoft Controller',1],['360 Controller',1],
 ['Nintendo Controller',3],['Switch Controller',3],['Joy-Con',3],['Pro Controller',3],
 ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0001)',2],
 ['Controller (Vendor:045e Product:0001)',1],['Controller (VENDOR:\t057E Product: 0001)',3],
 ['054C-0001-Generic Controller',2],['045e-0001-Generic Controller',1],['057E-0001-Generic Controller',3],
 ['',0],[null,0],[undefined,0],['Generic Controller',0],['Controller (Vendor: 1234 Product: 054c)',0],
 ['Generic 054c Controller',0],['Generic 045e Controller',0],['Generic 057e Controller',0],
 ['Generic Product: 054c',0],['Generic Product: 045e',0],['Generic Product: 057e',0],
 ['Generic 054c-0001',0],['1054c-0001-Generic',0],['054c0-0001-Generic',0],
 ['Generic (Vendor: 054c0)',0],['Generic (Vendor: 0054c)',0],['Generic (Vendor: 054c_extra)',0],
 ['Generic (NotVendor: 054c)',0],['Generic (Vendor: 054)',0],
 // Keep every established name match even when a wrapper has conflicting IDs.
 ['Xbox Controller (Vendor: 054c)',1],['DualSense Controller (Vendor: 045e)',2],['Pro Controller (Vendor: 045e)',3]
];
for(const [id,expected]of cases)assert.strictEqual(type(id),expected,String(id));
assert.strictEqual(current.c._gpControllerType(null),0);
// All four-digit vendor values: only the three approved vendors extend legacy
// detection. A legacy name hit (including "360") always retains its priority.
for(let value=0;value<65536;value++) {
 const vendor=value.toString(16).padStart(4,'0'),expected={'054c':2,'045e':1,'057e':3}[vendor]||0;
 for(const id of ['Generic (Vendor: '+vendor+' Product: 0001)',vendor+'-0001-Generic']) {
  const legacy=old.c._gpControllerType({id});assert.strictEqual(type(id),legacy||expected,id);
 }
}
// A formerly unknown Sony ID changes only the type field in the same production
// shared-memory snapshot. Inputs, capabilities, publication and stops stay exact.
for(const f of [current,old]){f.pad.id='Generic (Vendor: 054c Product: 0001)';f.c.startGamepadSnapshot(false);f.tick();}
let seed=74123;
for(let frame=0;frame<300;frame++) {
 seed=(Math.imul(seed,1664525)+1013904223)>>>0;
 for(const f of [current,old]) {
  f.pad.timestamp++;f.pad.axes[frame%4]=(seed%2049-1024)/1024;
  f.pad.buttons[frame%17]={pressed:!!(seed&1),value:(seed%1001)/1000};f.tick();
 }
 const a=Array.from(current.heap.slice(16,214)),b=Array.from(old.heap.slice(16,214));
 assert.strictEqual(a[6],2);assert.strictEqual(b[6],0);a[6]=b[6];assert.deepStrictEqual(a,b);
}
for(const f of [current,old])f.c.stopGamepadSnapshot();
assert.deepStrictEqual(Array.from(current.heap.slice(16,214)),Array.from(old.heap.slice(16,214)));
// Slot metadata is resolved once per connection, not on idle or moving frames.
const cached=fixture(source);let calls=0;
const detect=cached.c._gpControllerType;
cached.c._gpControllerType=pad=>{calls++;return detect(pad);};
cached.pad.id='045e-0001-Generic';cached.c.startGamepadSnapshot(false);cached.tick();
assert.strictEqual(calls,1);assert.strictEqual(cached.c._gpNextWords[5],1);
for(let frame=0;frame<1000;frame++){cached.pad.axes[0]=frame%2?0.25:-0.5;cached.tick();}
assert.strictEqual(calls,1,'no classifier work in connected-frame hot path');
cached.emit('gamepaddisconnected',cached.pad);cached.pad.id='057e-0001-Generic';cached.tick();
assert.strictEqual(calls,2);assert.strictEqual(cached.c._gpNextWords[5],3);
cached.c.stopGamepadSnapshot();
const normalize=require('./controller-vendor-scope.cjs').normalize;
assert.strictEqual(normalize(file,source),before,'only vendor fallback changes');
for(const [from,to]of [["vendor[1] === '054c'","vendor[1] === '1234'"],
 ['_gpNextWords[offset + 4] = _gpTypeForSlot[slot]','_gpNextWords[offset + 4] = 0'],
 ['var _RUMBLE_MIN_INTERVAL_MS = 100','var _RUMBLE_MIN_INTERVAL_MS = 200']]) {
 assert(source.includes(from));assert.notStrictEqual(normalize(file,source.replace(from,to)),before,'unknown edits remain visible');
}
console.log('controller_vendor_test: name compatibility, 131072 vendor formats, malformed/product rejection, exact snapshot except type, cached detection and reconnect passed');
