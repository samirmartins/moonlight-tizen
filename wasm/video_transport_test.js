'use strict';
// Actual RTP/depacketizer plus the verbatim active-receive service hook.
// Deterministic packet order/clock, not a measurement of TV performance.
const fs = require('fs'), cp = require('child_process'), os = require('os');
const path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..'), base = path.join(root, 'moonlight-common-c');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-transport-'));
const read = (file, old) => old ? cp.execFileSync('git', ['show', 'v3.4.9:' + file], {cwd: root, encoding: 'utf8'}) : fs.readFileSync(path.join(root, file), 'utf8');
function run(command, args, extra = {}) {
  const r = cp.spawnSync(command, args, {cwd: root, encoding: 'utf8', timeout: 60000, ...extra});
  assert.strictEqual(r.status, 0, command + ': ' + (r.stdout || '') + (r.stderr || '') + (r.error || ''));
  return r.stdout;
}
try {
  const observations = [];
  for (const old of [true, false]) {
    const dir = path.join(tmp, old ? 'baseline' : 'current'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'emscripten.h'), '#define EM_LOG_CONSOLE 1\nvoid emscripten_log(int,const char*,...);\n');
    fs.writeFileSync(path.join(dir, 'control_status.inc'), `
static unsigned intervalGoodFrameCount, intervalTotalFrameCount, intervalStartTimeMs, firstFrameTimeMs;
static unsigned lastSeenFrame, lastGoodFrame, lastIntervalLossPercentage, lastConnectionStatusUpdate;
void connectionSawFrame(uint32_t n) { lastSeenFrame=n; }
void connectionReceivedCompleteFrame(uint32_t n) { lastGoodFrame=n; }
`);
    fs.writeFileSync(path.join(dir, 'transport_base.inc'), fs.readFileSync(path.join(__dirname, 'video_recovery_fixture.c')));
    const receiver = read('moonlight-common-c/src/VideoStream.c', old);
    const start = receiver.indexOf('        // Partial frames can keep recv() busy');
    const end = receiver.indexOf('        if (!receivedDataFromPeer) {', start);
    const hook = old ? '' : receiver.slice(start, end);
    if (!old) {
      assert(start > receiver.indexOf('else if  (err == 0)') && end > start);
      assert(hook.includes('servicePendingVideoDecoderRefresh();'));
      assert(end < receiver.indexOf('queueStatus = RtpvAddPacket'));
    }
    fs.writeFileSync(path.join(dir, 'transport_receive.inc'), hook);
    for (const name of ['RtpVideoQueue.c', 'VideoDepacketizer.c'])
      fs.writeFileSync(path.join(dir, name), read('moonlight-common-c/src/' + name, old));
    const binary = path.join(dir, 'test');
    const flags = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-fno-pie',
      '-ffunction-sections', '-fdata-sections', '-DRECOVERY_FIXED=1', '-DTRANSPORT_REGRESSION=1',
      '-DTRANSPORT_FIXED=' + (old ? 0 : 1), '-DDEPACKETIZER_PATH=' + JSON.stringify(path.join(dir, 'VideoDepacketizer.c')),
      '-I' + dir, '-I' + path.join(base, 'src'), '-I' + path.join(base, 'enet/include'), '-I' + path.join(base, 'reedsolomon')];
    run('gcc', [...flags, path.join(__dirname, 'video_transport_fixture.c'), path.join(dir, 'RtpVideoQueue.c'),
      path.join(base, 'src/ByteBuffer.c'), path.join(base, 'reedsolomon/rs.c'), '-Wl,--gc-sections', '-no-pie', '-pthread', '-o', binary]);
    const result = run(binary, [], {env: {...process.env, ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
    observations.push(result.split('\n').filter(x => /^(HEALTHY|RFI|KNOWN_REORDER|REAL_LOSS)/.test(x)));
    console.log((old ? 'v3.4.9' : 'candidate') + '\n' + result.trim());
    if (old) {
      const negative = path.join(dir, 'negative');
      const negativeFlags = flags.map(x => x === '-DTRANSPORT_FIXED=0' ? '-DTRANSPORT_FIXED=1' : x);
      run('gcc', [...negativeFlags, path.join(__dirname, 'video_transport_fixture.c'), path.join(dir, 'RtpVideoQueue.c'),
        path.join(base, 'src/ByteBuffer.c'), path.join(base, 'reedsolomon/rs.c'), '-Wl,--gc-sections', '-no-pie', '-pthread', '-o', negative]);
      const rejected = cp.spawnSync(negative, [], {encoding: 'utf8', timeout: 10000});
      assert(rejected.status !== 0 && rejected.stderr.includes('accepted == 3'), 'reverting V1 is detected');
    }
  }
  assert.deepStrictEqual(observations[0], observations[1], 'healthy payload/timing/clock reads and RFI behavior preserved');
  console.log('video_transport_test: reordered frames retained; partial-traffic refresh timely; logs bounded; healthy and RFI equivalence PASS');
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
