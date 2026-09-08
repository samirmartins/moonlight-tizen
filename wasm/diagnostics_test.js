'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm');
let now = 0, nextTimer = 0, nextFrame = 0, cpuCalls = 0, memoryCalls = 0, allocations = 0, saved;
const timers = new Map(), frames = new Map(), listeners = new Map(), generations = [], cpus = [];
const elements = {};
const video = {
  drops: 100,
  requestVideoFrameCallback(fn) { frames.set(++nextFrame, fn); return nextFrame; },
  cancelVideoFrameCallback(id) { frames.delete(id); },
  addEventListener(type, fn) { listeners.set(type, fn); },
  removeEventListener(type) { listeners.delete(type); },
  getVideoPlaybackQuality() { return { droppedVideoFrames: video.drops }; }
};
function el(id) { return elements[id] || (elements[id] = { checked: false, textContent: '', appendChild() {} }); }
elements.wasm_module = video;
const c = { console, Math, JSON, isFinite, Date,
  Uint32Array: function(n) { allocations++; return new Uint32Array(n); },
  performance: { now: () => now }, Module: { setDiagnostics(gen) { generations.push(gen); } },
  document: { getElementById: el, createElement() { return { appendChild() {} }; } },
  setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
  clearTimeout(id) { timers.delete(id); },
  tizen: { systeminfo: {
    getAvailableMemory() { memoryCalls++; return 300 * 1048576; },
    getPropertyValue(type, fn) { cpuCalls++; cpus.push(fn); }
  } },
  XMLHttpRequest: function() {
    this.open = () => {}; this.abort = () => {};
    this.send = () => { this.responseText = '<tizen:metadata key="http://samsung.com/tv/metadata/use.game.mode" value="true"/>'; this.onload(); };
  },
  appInfo: { version: '3.3.8' }, modelName: 'Test TV', platformVer: '9.0', isInGame: true,
  _audRefreshStats() {},
  _mlAudioStats: { started: true, backend: 'AudioWorklet', depthMs: 42, targetMs: 43, underruns: 7, overruns: 0 },
  localStorage: { setItem(k, v) { saved = v; }, getItem() { return saved; } },
  snackbarLogLong() {}, openUtilityDialog() {}, closeUtilityDialog() {}
};
c.window = c;
vm.createContext(c);
// White-box bounds check only in this test; no debug API in production.
let source = fs.readFileSync('wasm/platform/diagnostics.js', 'utf8');
source = source.replace('start: start, connected: connected,', '_debug: function() { return session; }, start: start, connected: connected,');
vm.runInContext(source, c);
const d = c.SessionDiagnostics;
function sample(gen = 1, extra = {}) {
  return JSON.stringify(Object.assign({
    gen, ms: 2000, w: 2560, h: 1440, fmt: 256, fps: 60, bytes: 11000000, rx: 120, sub: 120,
    total: 120, lost: 0, rej: 0, rec: 0, rtt: 2, rttVar: 1, hostN: 120, hostLate: 1,
    hostMean: 16.667, hostP95: 18, enc: 4, encMax: 8,
    asm: .6, asmP95: 1, asmMax: 1.4, app: .8, appP95: 1.2, appMax: 2,
    cadN: 120, cadLate: 12, cadP95: 20, cadMax: 36, leadN: 120, lead: -5, leadAbsMax: 12,
    filtered: -3, target: 0, servo: 0, settle: 1800, clockAge: 100, step: 16.667
  }, extra));
}
function tick() {
  const [id, fn] = [...timers][0]; timers.delete(id); now += 2000; fn();
}
function frame(time, count) {
  const [id, fn] = [...frames][0]; frames.delete(id);
  fn(time, { expectedDisplayTime: time, presentedFrames: count });
}
// Disabled lifecycle is truly inert, including malformed/delayed messages.
d.start(); d.connected(); d.sample('not json'); d.finish();
assert.strictEqual(timers.size + frames.size + cpuCalls + memoryCalls + allocations, 0);
assert.deepStrictEqual(generations, []);
el('diagnosticsSwitch').checked = true;
d.start(); d.connected();
assert.deepStrictEqual(generations, [1]); assert.strictEqual(timers.size, 1); assert.strictEqual(frames.size, 1);
frame(100, 1); frame(116.667, 2); frame(183.334, 3); frame(250.001, 7);
assert.ok(d._debug().presentationMax > 66, 'long intervals are kept');
assert.strictEqual(d._debug().coalesced, 1, 'coalesced callbacks are distinct from drops');
d.sample('null'); d.sample('{"gen":1,"ms":2000}'); d.sample(sample(999));
assert.strictEqual(d._debug().windows, 0);
d.sample(sample());
assert.strictEqual(d._debug().metrics.lead.min, -5, 'signed lead is retained');
cpus.shift()({ load: .3 });
video.drops += 2; c._mlAudioStats.underruns += 1; tick();
const staleFrame = [...frames.values()][0];
// Simulate a long session without unbounded snapshots or timers.
for (let i = 0; i < 7200; i++) { now += 2000; d.sample(sample()); }
assert.strictEqual(d._debug().first.length, 15); assert.strictEqual(d._debug().last.length, 15);
assert.strictEqual(d._debug().presentationBins.length, 2048);
assert.strictEqual(timers.size, 1); assert.strictEqual(frames.size, 1);
d.finish('Exit code 0');
assert.strictEqual(timers.size + frames.size + listeners.size, 0);
assert.strictEqual(generations.at(-1), 0);
const report = JSON.parse(saved);
assert.strictEqual(report.rows.length, 9);
assert.match(report.title, /ForceGM/);
assert.match(report.config, /2560×1440 HEVC 60fps/);
assert.match(report.rows[5][1], /-5.0→-5.0/);
assert.match(report.rows[4][1], /drop \+2/);
assert.match(report.rows[6][1], /ΔU\/O 1\/0/);
assert.ok(saved.length < 6000);
const queries = cpuCalls + memoryCalls;
staleFrame(500, { presentedFrames: 10 });
d.sample(sample()); d.connected();
assert.strictEqual(timers.size + frames.size, 0);
assert.strictEqual(cpuCalls + memoryCalls, queries);
// A prior CPU callback/native window cannot affect a new session.
d.start(); d.connected();
const fresh = d._debug(); d.sample(sample(1));
assert.strictEqual(fresh.windows, 0); d.sample(sample(2)); assert.strictEqual(fresh.windows, 1);
el('diagnosticsSwitch').checked = false; d.changed();
assert.strictEqual(timers.size + frames.size + listeners.size, 0);
const last = saved; cpus.forEach(fn => fn({ load: .99 })); assert.strictEqual(saved, last);
// Capability failures remain unavailable, not zero/healthy measurements.
c.tizen.systeminfo.getAvailableMemory = () => { throw new Error('unavailable'); };
delete video.requestVideoFrameCallback;
c._mlAudioStats.started = false;
el('diagnosticsSwitch').checked = true; d.start(); d.connected(); d.sample(sample(3, { rtt: -1, hostN: 0, cadN: 0, leadN: 0 })); d.finish();
const unavailable = JSON.parse(saved);
assert.match(unavailable.rows[0][1], /--/);
assert.match(unavailable.rows[6][1], /--\/--/);
assert.match(unavailable.rows[7][1], /--→--/);
console.log('diagnostics_test: ok (OFF, bounds, counters, capabilities, stale callbacks, repeated sessions)');
