'use strict';
// Tested pairing-pause exceptions only. Native pairing, launcher, library and
// historical baselines remain frozen; unknown surrounding edits stay visible.
const cp=require('child_process'),crypto=require('crypto'),assert=require('assert');
const sections=[
 ['function beginBackgroundPollingOfHost(', 'function endBackgroundPollingOfHost(', 'c657c66dc8381c68e1d6362d4dd68c7d5ae96515ff6107efb87f6c88b9d84536', 'function beginBackgroundPollingOfHost('],
 ['// Pause every host, including callbacks', '// Add the new NvHTTP Host object', '2f72f78f34441c20aba39a9151d35de9d4cffc85d27935cf637ff58815d22bc3', '// Show the Pairing dialog before pairing']
];
let baseline;
function normalize(file,source){
 if(file==='wasm/platform/app-lifecycle.js')return source.replace(
  "      restoreHostPolling = (typeof hostPollScopes !== 'undefined' && Object.keys(hostPollScopes).length > 0) ||\n        (typeof pairingPollingPause !== 'undefined' && !!pairingPollingPause);",
  "      restoreHostPolling = typeof hostPollScopes !== 'undefined' && Object.keys(hostPollScopes).length > 0;");
 if(file!=='wasm/platform/index.js')return source;
 for(const [begin,end,hash,oldBegin]of sections){
  const a=source.indexOf(begin),b=source.indexOf(end,a);
  if(a<0||b<=a||crypto.createHash('sha256').update(source.slice(a,b)).digest('hex')!==hash)continue;
  if(!baseline)baseline=cp.execFileSync('git',['show','04dfc66:'+file],{encoding:'utf8'});
  const x=baseline.indexOf(oldBegin),y=baseline.indexOf(end,x);assert(x>=0&&y>x);
  source=source.slice(0,a)+baseline.slice(x,y)+source.slice(b);
 }
 return source.replace('var pairingPollingPause = null;\n','');
}
module.exports={normalize};
