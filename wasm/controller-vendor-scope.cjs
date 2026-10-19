'use strict';
// Reverse only the tested vendor fallback. Names, slot caching, shared-memory
// layout, sampling and actuator policy must retain their previous contracts.
const cp=require('child_process'),crypto=require('crypto'),assert=require('assert');
let previous;
function normalize(file,source) {
 if(file!=='wasm/platform/gamepad.js')return source;
 const begin='function _gpControllerType(',end='function _gpIsUsable(';
 const a=source.indexOf(begin),b=source.indexOf(end,a);
 if(a<0||b<=a||crypto.createHash('sha256').update(source.slice(a,b)).digest('hex')!==
   '64cb7a728eb5849ea509d269217ed2294cb6a32cb071a97bac4c2565e86751d1')return source;
 if(!previous)previous=cp.execFileSync('git',['show','f89c0bb:'+file],{encoding:'utf8'});
 const x=previous.indexOf(begin),y=previous.indexOf(end,x);assert(x>=0&&y>x);
 return source.slice(0,a)+previous.slice(x,y)+source.slice(b);
}
module.exports={normalize};
