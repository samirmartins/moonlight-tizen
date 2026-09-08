'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const timers = new Map();
let timerId = 0, updates = 0;
const elements = {};
function element(id) {
  return elements[id] || (elements[id] = { textContent: '', value: '', disabled: false,
    classList: { toggle() {}, remove() {} }, style: {} });
}
const c = { console: { log() {}, error() {}, warn() {} }, Promise, isInGame: false, isDialogOpen: false,
  setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
  clearTimeout(id) { timers.delete(id); }, document: { getElementById: element },
  hosts: {}, activePolls: {}, updateHostStatusIndicator() { updates++; },
  openUtilityDialog() {}, closeUtilityDialog() {}, saveHosts() {},
  sendMessage() { return Promise.resolve('ok'); }, navigator: {} };
c.window = c;
vm.createContext(c);
vm.runInContext(fs.readFileSync('wasm/platform/menu-tools.js', 'utf8'), c);
vm.runInContext(fs.readFileSync('wasm/static/js/utils.js', 'utf8'), c);
const index = fs.readFileSync('wasm/platform/index.js', 'utf8');
vm.runInContext(index.slice(index.indexOf('var hostPollScopes ='), index.indexOf('function snackbarLog(')), c);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
(async () => {
  assert.strictEqual(c.normalizeWakeMac('12-34-56-78-9a-bc'), '12:34:56:78:9A:BC');
  assert.strictEqual(c.normalizeWakeMac(' 12:34:56:78:9a:bc '), '12:34:56:78:9A:BC');
  for (const bad of ['', '00:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF', '01:34:56:78:9a:bc', '12:34-56:78:9A:BC', '123456789abc']) assert.strictEqual(c.normalizeWakeMac(bad), '');
  const pending = deferred(), scope = c.createMenuRequestScope();
  let cancelled = 0;
  pending.promise.cancel = () => cancelled++;
  const request = scope.request(() => pending.promise, 5000).catch(e => e.message);
  assert.strictEqual(timers.size, 1);
  scope.cancel();
  assert.strictEqual(timers.size, 0);
  assert.strictEqual(cancelled, 1);
  pending.resolve('late');
  assert.match(await request, /cancelled/);
  const refresh = deferred();
  const host = { serverUid: 'one', online: true, refreshServerInfo: () => refresh.promise,
    pollServer(cb) { cb(host); }, _pollCompletionCallbacks: [] };
  c.hosts.one = host;
  c.beginBackgroundPollingOfHost(host);
  c.stopPollingHosts();
  refresh.resolve();
  await flush();
  assert.strictEqual(timers.size, 0, 'late initial refresh cannot restart polling');
  assert.strictEqual(updates, 0);
  host.refreshServerInfo = () => Promise.resolve();
  c.beginBackgroundPollingOfHost(host); await flush();
  assert.strictEqual(timers.size, 1);
  c.beginBackgroundPollingOfHost(host); await flush();
  assert.strictEqual(timers.size, 1, 'one timer after repeated starts');
  let oldComplete;
  host.pollServer = cb => { oldComplete = cb; };
  const [id, fn] = [...timers][0]; timers.delete(id); fn();
  c.stopPollingHosts(); c.isInGame = true; oldComplete();
  assert.strictEqual(timers.size, 0, 'late poll completion cannot schedule in game');
  c.beginBackgroundPollingOfHost(host);
  assert.strictEqual(timers.size, 0);
  c.isInGame = false;
  const nv = new c.NvHTTP('192.168.1.2', 'test');
  nv.httpPort = 47989; nv.httpsPort = 47984; nv.ppkstr = 'pinned';
  let parses = 0, requests = 0;
  nv._parseServerInfo = () => { parses++; return false; };
  const reply = deferred(), scope2 = c.createMenuRequestScope();
  c.sendMessage = () => { requests++; return reply.promise; };
  const work = nv.refreshServerInfoScoped('192.168.1.2', scope2).catch(() => {});
  scope2.cancel(); reply.resolve('late XML'); await work; await flush();
  assert.strictEqual(parses, 0); assert.strictEqual(requests, 1);
  assert.strictEqual(timers.size, 0, 'no XML parsing, fallback or deadline after stop');
  c.openUtilityDialog = () => {}; c.closeUtilityDialog = () => {};
  let wake = deferred();
  host.macAddress = '12:34:56:78:9A:BC';
  host.sendWOL = () => wake.promise;
  host.selectServerAddress = (success, failure) => failure(new Error('offline'));
  c.WakeHost.open(host);
  element('wakeSend').onclick();
  assert.strictEqual(timers.size, 2);
  wake.resolve(); await flush();
  assert.match(element('wakeStatus').textContent, /sent/);
  c.WakeHost.cancel();
  assert.strictEqual(timers.size, 0, 'cancel wake clears retry/deadline');
  host.online = false;
  host._consecutivePollFailures = 9;
  host.refreshServerInfo = () => Promise.resolve();
  c.beginBackgroundPollingOfHost(host); await flush();
  assert.strictEqual(host.online, true, 'successful initial refresh immediately marks PC online');
  assert.strictEqual(host._consecutivePollFailures, 0);
  c.stopPollingHosts();
  host.online = false;
  host.sendWOL = () => Promise.resolve();
  c.WakeHost.open(host);
  element('wakeSend').onclick(); await flush();
  const [deadlineId, deadlineFn] = [...timers][0];
  timers.delete(deadlineId); deadlineFn(); await flush();
  assert.strictEqual(host.online, true, 'wake deadline resumes normal host discovery');
  c.WakeHost.hostUpdated(host);
  assert.match(element('wakeStatus').textContent, /PC online/);
  c.stopPollingHosts(); c.WakeHost.cancel();
  assert.strictEqual(timers.size, 0);
  console.log('menu_tools_test: ok');
})().catch(e => { console.error(e); process.exitCode = 1; });
