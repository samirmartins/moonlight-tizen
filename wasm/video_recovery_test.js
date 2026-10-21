'use strict';
// Compare real RTP/depacketizer recovery against the last released baseline.
// Synthetic packets/clock and a fake Samsung result are not hardware evidence.
const fs = require('fs'), path = require('path'), os = require('os');
const cp = require('child_process'), crypto = require('crypto'), assert = require('assert');
const root = path.resolve(__dirname, '..'), reference = 'v3.4.7';
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--output'),
  'Usage: node wasm/video_recovery_test.js [--output private-directory]');
const output = args.length ? path.resolve(args[1]) : null;
if (output && (output === root || output.startsWith(root + path.sep))) throw Error('Reports must stay outside the public repository');
const read = (file, legacy = false) => legacy
  ? cp.execFileSync('git', ['show', reference + ':' + file], {cwd: root, encoding: 'utf8'})
  : fs.readFileSync(path.join(root, file), 'utf8');
const sha = content => crypto.createHash('sha256').update(content).digest('hex');
function method(source, signature) {
  const start = source.indexOf(signature);
  assert(start >= 0 && source.indexOf(signature, start + 1) < 0, signature);
  let cursor = source.indexOf('{', start), depth = 0;
  do { const c = source[cursor++]; if (c === '{') depth++; else if (c === '}') depth--; }
  while (depth && cursor < source.length);
  assert.strictEqual(depth, 0);
  return source.slice(start, cursor);
}
function extracted(video, control) {
  const start = video.indexOf('  const bool appended = (bool)g_Instance->m_VideoTrack.AppendPacket(pkt);');
  const end = video.indexOf('\n  return DR_OK;', start) + '\n  return DR_OK;'.length;
  assert(start > 0 && end > start);
  const constants = ['kIdrRequestIntervalMs', 's_lastIdrRequestMs'].map(name => {
    const m = video.match(new RegExp('^static (?:constexpr )?uint32_t ' + name + ' = [^;]+;', 'm'));
    assert(m, name); return m[0];
  }).join('\n');
  const fields = ['intervalGoodFrameCount', 'intervalTotalFrameCount', 'intervalStartTimeMs',
    'lastIntervalLossPercentage', 'lastConnectionStatusUpdate', 'firstFrameTimeMs', 'lastSeenFrame', 'lastGoodFrame'];
  const status = fields.map(name => {
    const m = control.match(new RegExp('^static (?:int|uint32_t|uint64_t) ' + name + ';', 'm'));
    assert(m, name); return m[0];
  }).concat(['CONN_IMMEDIATE_POOR_LOSS_RATE', 'CONN_CONSECUTIVE_POOR_LOSS_RATE', 'CONN_OKAY_LOSS_RATE', 'CONN_STATUS_SAMPLE_PERIOD'].map(name => {
    const m = control.match(new RegExp('^#define ' + name + ' +[^\\n]+', 'm'));
    assert(m, name); return m[0];
  }), [method(control, 'void connectionReceivedCompleteFrame('), method(control, 'void connectionSawFrame(')]).join('\n');
  return {tail: video.slice(start, end), constants, status};
}
const inputs = ['wasm/wasmplayer.cpp', 'moonlight-common-c/src/VideoDepacketizer.c',
  'moonlight-common-c/src/VideoStream.c', 'moonlight-common-c/src/RtpVideoQueue.c',
  'moonlight-common-c/src/ControlStream.c', 'moonlight-common-c/src/ByteBuffer.c',
  'moonlight-common-c/reedsolomon/rs.c', 'wasm/video_recovery_test.js',
  'wasm/video_recovery_fixture.cpp', 'wasm/video_recovery_fixture.c'];
for (const directory of ['moonlight-common-c/src', 'moonlight-common-c/enet/include/enet', 'moonlight-common-c/reedsolomon'])
  for (const name of fs.readdirSync(path.join(root, directory)))
    if (name.endsWith('.h')) inputs.push(directory + '/' + name);
const hashes = Object.fromEntries(inputs.map(p => [p, sha(fs.readFileSync(path.join(root, p)))]));
const report = {
  source_commit: cp.execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  baseline: reference, created_utc: new Date().toISOString(), inputs_sha256: hashes,
  scope: 'Real RTP/depacketizer; extracted submit/status code; fake Samsung results and clock.',
  limits: 'No real network/decoder/TV timing or performance measured. No widget generated.',
  variants: {}, comparison: [], status: 'NOT_RUN'
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-video-recovery-'));
let log = '';
function run(command, arguments_, extra = {}) {
  const result = cp.spawnSync(command, arguments_, {cwd: root, encoding: 'utf8', timeout: 60000,
    maxBuffer: 4 * 1024 * 1024, ...extra});
  log += String(result.stdout || '') + String(result.stderr || '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(command + ' failed: ' + (result.signal || result.status));
  return result.stdout;
}
const sanitizerEnv = {...process.env, ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1',
  UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1'};
try {
  const recoveryScope = require('./video-recovery-scope.cjs');
  for (const file of recoveryScope.files) {
    const source = read(file), baseline = read(file, true);
    assert.strictEqual(recoveryScope.normalize(file, source), baseline, 'strict approved patch: ' + file);
    assert.notStrictEqual(recoveryScope.normalize(file, source + '\n// unauthorized edit\n'), baseline,
      'unknown edit must remain visible: ' + file);
  }
  const base = path.join(root, 'moonlight-common-c');
  for (const legacy of [true, false]) {
    const name = legacy ? 'baseline' : 'current', directory = path.join(temporary, name);
    fs.mkdirSync(directory);
    const video = read('wasm/wasmplayer.cpp', legacy), control = read('moonlight-common-c/src/ControlStream.c', legacy);
    const {tail, constants, status} = extracted(video, control);
    fs.writeFileSync(path.join(directory, 'emscripten.h'), '#define EM_LOG_CONSOLE 0\n#define emscripten_log(...) ((void)0)\n');
    fs.writeFileSync(path.join(directory, 'append_tail.inc'), tail);
    fs.writeFileSync(path.join(directory, 'append_constants.inc'), constants);
    fs.writeFileSync(path.join(directory, 'control_status.inc'), status);
    const depacketizer = path.join(directory, 'depacketizer.c');
    fs.writeFileSync(depacketizer, read('moonlight-common-c/src/VideoDepacketizer.c', legacy));
    const flags = ['-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-fno-pie',
      '-ffunction-sections', '-fdata-sections', '-DLC_DEBUG', '-DRECOVERY_FIXED=' + (legacy ? 0 : 1),
      '-I' + directory, '-I' + path.join(base, 'src'), '-I' + path.join(base, 'enet/include'), '-I' + path.join(base, 'reedsolomon')];
    const objects = [];
    for (const source of [path.join(__dirname, 'video_recovery_fixture.c'), path.join(base, 'src/RtpVideoQueue.c'),
      path.join(base, 'src/ByteBuffer.c'), path.join(base, 'reedsolomon/rs.c')]) {
      const object = path.join(directory, path.basename(source) + '.o'); objects.push(object);
      run('gcc', ['-std=c11', ...flags, '-DDEPACKETIZER_PATH=' + JSON.stringify(depacketizer), '-c', source, '-o', object]);
    }
    const compileDriver = binary => run('g++', ['-std=c++17', ...flags, '-no-pie',
      path.join(__dirname, 'video_recovery_fixture.cpp'), ...objects, '-Wl,--gc-sections', '-pthread', '-o', binary]);
    const binary = path.join(directory, 'test'); compileDriver(binary);
    const observations = run(binary, [], {env: sanitizerEnv});
    const checks = observations.split('\n').filter(x => x.startsWith('CASE\t')).map(line => {
      const [, name, status, evidence] = line.split('\t'); return {name, status, evidence};
    });
    assert.strictEqual(checks.length, legacy ? 11 : 12, 'native completion markers');
    const summary = observations.split('\n').find(x => x.startsWith('SUMMARY\tchecks='));
    assert(summary, 'native completion marker');
    report.variants[name] = {summary, checks, healthy: observations.split('\n').filter(x => x.startsWith('HEALTHY\t')),
      extraction_sha256: {tail: sha(tail), constants: sha(constants), status: sha(status)}, sanitizers: 'ASan/UBSan/LSan: no reported violations'};
    const stress = observations.split('\n').filter(x => x.startsWith('STRESS\t')).map(line => {
      const values = line.split('\t').slice(1).map(Number);
      return Object.fromEntries(['codec', 'metrics', 'fragments', 'fps', 'seed', 'frames',
        'offered_failures', 'append_failures', 'unsafe_submissions', 'forgotten_recovery', 'requests']
        .map((key, index) => [key, values[index]]));
    });
    assert.strictEqual(stress.length, 72, 'seeded simulation completion markers');
    report.variants[name].stress = stress;
    console.log(name + ': ' + summary);
    if (!legacy) {
      // A generated-only mutation must be caught by the actual behavioral assertions.
      const mutated = tail.replace('return DR_NEED_IDR;', 'return DR_OK;');
      assert.notStrictEqual(mutated, tail);
      fs.writeFileSync(path.join(directory, 'append_tail.inc'), mutated);
      const negativeBinary = path.join(directory, 'negative'); compileDriver(negativeBinary);
      const negative = cp.spawnSync(negativeBinary, [], {cwd: root, encoding: 'utf8', timeout: 10000, env: sanitizerEnv});
      assert(!negative.error && negative.status !== 0 && String(negative.stderr).includes(
        'first rejection requests IDR and enters recovery'), 'negative control was not detected');
      report.negative_control = 'PASS: suppressing recovery in a temporary snippet is rejected';
    }
  }
  assert.deepStrictEqual(report.variants.current.healthy, report.variants.baseline.healthy,
    'healthy payload/sequence/timestamps, submit count and clock-read count must match the release');
  const schedule = items => items.map(({codec, metrics, fragments, fps, seed, frames, offered_failures}) =>
    ({codec, metrics, fragments, fps, seed, frames, offered_failures}));
  assert.deepStrictEqual(schedule(report.variants.current.stress), schedule(report.variants.baseline.stress),
    'both variants receive exactly the same deterministic fault schedule');
  report.stress_comparison = {};
  for (const name of ['baseline', 'current']) {
    const items = report.variants[name].stress;
    report.stress_comparison[name] = {
      scenarios: items.length,
      frames: items.reduce((sum, row) => sum + row.frames, 0),
      unsafe_submissions: items.reduce((sum, row) => sum + row.unsafe_submissions, 0),
      forgotten_recovery: items.reduce((sum, row) => sum + row.forgotten_recovery, 0)
    };
  }
  console.log('seeded recovery simulations: ' + JSON.stringify(report.stress_comparison));
  const legacyCases = new Map(report.variants.baseline.checks.map(x => [x.name, x]));
  report.comparison = report.variants.current.checks.map(item => ({name: item.name,
    baseline: legacyCases.get(item.name)?.status || 'NOT_TESTED', current: item.status}));
  assert(report.comparison.filter(x => x.baseline === 'FAIL_REPRODUCED' && x.current === 'PASS').length === 4);
  assert(!report.variants.current.checks.some(x => x.status === 'FAIL_REPRODUCED'));
  // No timer/polling is added: the idle hook is inside the existing timeout only.
  const receiver = read('moonlight-common-c/src/VideoStream.c');
  assert(receiver.includes('else if  (err == 0) {\n            if (!PltIsThreadInterrupted(&receiveThread)) {\n                servicePendingVideoDecoderRefresh();'));
  assert.strictEqual(receiver.split('servicePendingVideoDecoderRefresh();').length, 2);
  report.healthy_equivalence = 'PASS: 12 codec/fragment/metrics combinations match payload hash, timestamps, calls and clock reads';
  assert(inputs.every(p => sha(fs.readFileSync(path.join(root, p))) === hashes[p]), 'inputs changed during test');
  report.status = 'PASS';
  for (const item of report.comparison) console.log(item.name + ': ' + item.baseline + ' -> ' + item.current);
  console.log('video_recovery_test: recovery contracts, throttling, deferred requests and unchanged healthy work passed');
} catch (error) {
  report.status = 'FAILED'; report.error = String(error.message).slice(0, 1000);
  process.exitCode = 1; console.error(log.slice(-6000)); console.error(report.error);
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
  if (output) {
    fs.mkdirSync(output, {recursive: true});
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'validation.log'), log);
  }
}
