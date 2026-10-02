'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
let poll,changes=[],pads=[],listeners={};
const buttons=()=>Array.from({length:17},()=>({pressed:false,value:0}));
const pad={index:0,connected:true,buttons:buttons(),axes:[0,0]};pads=[pad];
const c={navigator:{getGamepads:()=>pads},setInterval(fn){poll=fn;return 1;},clearInterval(){poll=null;},
  addEventListener(name,fn){listeners[name]=fn;},dispatchEvent(event){changes.push(event.detail);},
  CustomEvent:function(name,params){this.detail=params.detail;},console,Set,Float64Array,Int32Array,Uint8Array,Uint32Array};
c.window=c;vm.createContext(c);
vm.runInContext(fs.readFileSync('wasm/platform/gamepad.js','utf8')+'\nwindow.testController=Controller;',c);
c.testController.startWatching();pad.buttons[15].pressed=true;poll();assert.strictEqual(changes.length,1);
c.testController.stopWatching();pad.buttons[15].pressed=false;c.testController.startWatching();
pad.buttons[14].pressed=true;poll();assert.strictEqual(changes.length,2,'existing pad returns after stop/start');
pad.buttons.push({pressed:false,value:0});poll();pad.buttons[13].pressed=true;poll();assert.strictEqual(changes.length,3,'changed layout must not disable pad permanently');
const pad2={index:1,connected:true,buttons:buttons(),axes:[0,0]};pads.push(pad2);poll();pad2.buttons[12].pressed=true;poll();
assert.strictEqual(changes.length,4,'lost gamepadconnected event recovers during menu polling');
c.testController.stopWatching();assert.strictEqual(poll,null);
console.log('controller_menu_test: already-connected, resume, layout change and missed connection event OK');
