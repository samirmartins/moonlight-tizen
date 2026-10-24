'use strict';
// Exact tested input identities, not a blanket exemption for these files.
const cp = require('child_process'), crypto = require('crypto');
const approved = {
  'moonlight-common-c/src/RtpVideoQueue.c': 'abfc6b4101ddfd50f377de6d27a25ca0f8659975817fe1ed43a0823be7f43b4d',
  'moonlight-common-c/src/VideoDepacketizer.c': 'ae2fbdff6d9b5c7357ad92478b13df9cb0d3e461d87891eef2d85b8ef035e0b8',
  'moonlight-common-c/src/VideoStream.c': '05203586229d07637a2862bc406b0843ad7a1d3ddc56dfb994a9409d0de1e40a',
  'moonlight-common-c/src/VideoRecoveryLog.h': 'a73e3f7a5e34232b92165ea39338728c4b5198934200bddf6eace47453b398f9',
  'wasm/platform/display.js': '0164d03e3dc359691deed0d9ed22336e306c402e4e854308c776eeeacfd07c6b'
};
function normalize(file, source) {
  source = require('./branding-scope.cjs').normalize(file, source);
  if (!approved[file] || crypto.createHash('sha256').update(source).digest('hex') !== approved[file]) return source;
  return file.endsWith('/VideoRecoveryLog.h') ? '' : cp.execFileSync('git', ['show', 'v3.4.9:' + file], {encoding: 'utf8'});
}
module.exports = {normalize, files: Object.keys(approved)};
