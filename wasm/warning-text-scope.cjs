'use strict';
// Only the two approved string literals are normalized, never control flow.
const changes = {
  'wasm/connectionlistener.cpp': [
    '"Video stream unstable. Check connection or settings."',
    '"Slow connection to PC.\\nReduce your bitrate!"'
  ],
  'wasm/platform/messages.js': [
    "'Stream ended. Check connection or settings.'",
    "'Your network connection isn\\'t performing well. Reduce your video bitrate setting or try a faster connection.'"
  ]
};
function normalize(file, source) {
  const change = changes[file];
  return change ? source.replace(change[0], change[1]) : source;
}
module.exports = {normalize, files: Object.keys(changes)};
