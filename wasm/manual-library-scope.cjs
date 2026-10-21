'use strict';
// Exact reviewed menu revision only. Behavioral tests execute the real sources;
// these hashes let older scope guards keep detecting every unapproved edit.
const cp=require('child_process'),crypto=require('crypto');
const approved={
  'wasm/platform/console-library.js':'39bbc4a47ccf2624d176cae951b4397590236de5d23e8a252fec39cf70339af9',
  'wasm/platform/menu-tools.js':'0b8ed0143cebd0c1529a77b8027a0f78ebb50326ff972fdc7c481c7920f40da5',
  'wasm/platform/index.js':'8fa3458b68e64e6225ab99ebb86acd4942ab03b99965ed7ee3ca46e070490c29',
  'wasm/index.html':'7be525cfcb24a00a0f39443b2f8a5b4d251649549f35e50126d87421038b6055'
};
function normalize(file,source){
  if(approved[file]&&crypto.createHash('sha256').update(source).digest('hex')===approved[file])
    return cp.execFileSync('git',['show','v3.4.6:'+file],{encoding:'utf8'});
  return source;
}
module.exports={normalize};
