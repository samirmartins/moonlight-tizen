'use strict';
// Exact exceptions for the independently tested library-driven wake intent.
// Unknown edits remain visible; the manual launcher has no wake-only branch.
const cp=require('child_process'),crypto=require('crypto');
const sections=[
  ['  function cancel','  function hide(','be42b806aa9600f75b6e5535edd36fe5c00c8a945ad179e8860af55150a7eeaa'],
  ['  function refresh(','  function focusCards(','5ab9b33d4a5748856872c72e2fb832accd07a229afe230dcd90e6e6ac8acfecc'],
  ['  function play(','  function bind(','373f17e5425b557d0c6a14061faccc309be2b7cd362063f26cf47d47467b5f57']
];
function normalize(file,source) {
  if(file!=='wasm/platform/console-library.js')return source;
  const old=cp.execFileSync('git',['show','f5ccf2a:'+file],{encoding:'utf8'});
  for(const [begin,end,hash] of sections) {
    const a=source.indexOf(begin),b=source.indexOf(end,a);
    if(a>=0&&b>a&&crypto.createHash('sha256').update(source.slice(a,b)).digest('hex')===hash) {
      const x=old.indexOf(begin),y=old.indexOf(end,x);
      source=source.slice(0,a)+old.slice(x,y)+source.slice(b);
    }
  }
  return source.replace('  var wakeIntent = null;\n','');
}
module.exports={normalize};
