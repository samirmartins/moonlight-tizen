'use strict';
// Compile the production dispatcher and delivery guard; the frontend is drained explicitly.
const fs = require('fs'), cp = require('child_process'), path = require('path'), assert = require('assert'), vm = require('vm');
const source = fs.readFileSync('wasm/connectionlistener.cpp', 'utf8');
const wording = require('./warning-text-scope.cjs');
for (const file of wording.files) {
  const current = fs.readFileSync(file, 'utf8');
  const old = cp.execFileSync('git', ['show', 'v3.4.7:' + file], {encoding: 'utf8'});
  assert.strictEqual(wording.normalize(file, current), old, file + ' changes only the approved literal');
  assert.notStrictEqual(wording.normalize(file, current + '\n// Unexpected edit\n'), old,
    'neighboring changes remain visible');
  assert.notStrictEqual(wording.normalize(file, current.replace('Check connection or settings.', 'Different advice.')), old,
    'unapproved wording remains visible');
}
const start = source.indexOf('// Runs on the browser thread');
const end = source.indexOf('CONNECTION_LISTENER_CALLBACKS', start);
assert(start > 0 && end > start);
const body = source.slice(start, end);
const callback = body.slice(body.indexOf('void MoonlightInstance::ClConnectionStatusUpdate'));
assert.doesNotMatch(callback, /PostToJs\(|\bemscripten_sync_run_in_main_runtime_thread\(/);
assert.match(callback, /emscripten_async_run_in_main_runtime_thread\(/);
const baseline = cp.execFileSync('git', ['show', 'v3.4.2:wasm/connectionlistener.cpp'], {encoding: 'utf8'});
assert.strictEqual(source.slice(0, start), baseline.slice(0, baseline.indexOf('void MoonlightInstance::ClConnectionStatusUpdate')));
assert.strictEqual(source.slice(end), baseline.slice(baseline.indexOf('CONNECTION_LISTENER_CALLBACKS')));
assert.strictEqual(fs.readFileSync('wasm/moonlight_wasm.hpp', 'utf8').replace(
  '  static void ApplyConnectionStatus(int connectionStatus, int generation);\n', ''),
  require('./controller-mapping-scope.cjs').legacy('wasm/moonlight_wasm.hpp',
    cp.execFileSync('git', ['show', 'v3.4.2:wasm/moonlight_wasm.hpp'], {encoding: 'utf8'})),
  'no unrelated header or layout changes beyond retired flip arguments');
const fixture = `
#include <atomic>
#include <cassert>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>
#include <iostream>
constexpr int CONN_STATUS_OKAY = 0, CONN_STATUS_POOR = 1, EM_FUNC_SIG_VII = 7;
class MoonlightInstance {
  bool m_DisableWarningsEnabled = false;
  std::atomic<bool> m_ConnectionCancelled{false}, m_Running{true};
  std::atomic<uint32_t> m_SessionGeneration{1};
  bool IsCurrentSession(uint32_t g) const { return g == m_SessionGeneration.load(); }
  static void ApplyConnectionStatus(int, int);
  friend int main();
public:
  static void ClConnectionStatusUpdate(int);
};
MoonlightInstance* g_Instance = nullptr;
struct Pending { void (*callback)(int, int); int status, generation; };
std::vector<Pending> pending;
std::vector<std::string> messages;
const auto browserThread = std::this_thread::get_id();
void PostToJs(std::string text) {
  assert(std::this_thread::get_id() == browserThread);
  messages.push_back(text);
}
void emscripten_async_run_in_main_runtime_thread(int signature, void (*callback)(int, int), int status, int generation) {
  assert(signature == EM_FUNC_SIG_VII);
  pending.push_back({callback, status, generation});
}
${body}
void Queue(int status) {
  const auto before = messages.size();
  std::thread receiver([=] { MoonlightInstance::ClConnectionStatusUpdate(status); });
  receiver.join();
  assert(messages.size() == before); // The receive thread never waits for UI delivery.
}
void Drain() {
  auto tasks = std::move(pending); pending.clear();
  for (auto& task : tasks) task.callback(task.status, task.generation);
}
int main() {
  MoonlightInstance app; g_Instance = &app;
  const std::string poor = "WarningMsg: Video stream unstable. Check connection or settings.";
  const std::string okay = "NoWarningMsg: Connection to PC has been improved.";
  Queue(CONN_STATUS_POOR); Queue(CONN_STATUS_OKAY);
  assert(pending.size() == 2 && messages.empty()); Drain();
  assert(messages == std::vector<std::string>({poor, okay})); messages.clear();
  // Stop, cancel, changed session or disabled warnings invalidate queued work.
  Queue(CONN_STATUS_POOR); app.m_ConnectionCancelled = true; Drain(); assert(messages.empty());
  Queue(CONN_STATUS_POOR); assert(pending.empty()); app.m_ConnectionCancelled = false;
  Queue(CONN_STATUS_POOR); app.m_Running = false; Drain(); assert(messages.empty()); app.m_Running = true;
  Queue(CONN_STATUS_POOR); app.m_SessionGeneration++; Queue(CONN_STATUS_OKAY); Drain();
  assert(messages == std::vector<std::string>({okay})); messages.clear();
  Queue(CONN_STATUS_POOR); app.m_DisableWarningsEnabled = true; Drain(); assert(messages.empty());
  Queue(CONN_STATUS_POOR); assert(pending.empty()); app.m_DisableWarningsEnabled = false;
  Queue(99); assert(pending.empty());
  Queue(CONN_STATUS_POOR); g_Instance = nullptr; Drain(); assert(messages.empty());
  Queue(CONN_STATUS_POOR); assert(pending.empty()); g_Instance = &app;
  // Generation bit patterns survive the SDK's two signed scalar arguments.
  app.m_SessionGeneration = 0x80000001u; Queue(CONN_STATUS_POOR); Drain();
  assert(messages == std::vector<std::string>({poor})); messages.clear();
  for (int session = 0; session < 100; ++session) {
    Queue(CONN_STATUS_POOR); app.m_SessionGeneration++; Queue(CONN_STATUS_OKAY); Drain();
    assert(messages == std::vector<std::string>({okay})); messages.clear();
  }
  std::cout << "native warnings: approved wording, asynchronous FIFO and stop/session guards passed\\n";
}
`;
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'moonlight-warning-test-'));
try {
  const file = path.join(tmp, 'test.cpp'), bin = path.join(tmp, 'test');
  fs.writeFileSync(file, fixture);
  cp.execFileSync('g++', ['-std=c++17', '-O1', '-g', '-pthread', '-fsanitize=address,undefined',
    '-fno-omit-frame-pointer', file, '-o', bin], {stdio: 'inherit'});
  cp.execFileSync(bin, [], {stdio: 'inherit', timeout: 10000});
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }

// Run the complete production handler. Apart from the approved display text,
// termination cleanup, diagnostics, menu restoration and timing must match.
const messagesFile = 'wasm/platform/messages.js';
const oldMessages = cp.execFileSync('git', ['show', 'v3.4.7:' + messagesFile], {encoding: 'utf8'});
const newMessages = fs.readFileSync(messagesFile, 'utf8');
function dispatch(code, message) {
  const trace = [];
  const record = name => (...args) => trace.push([name, ...args]);
  const context = {
    console: {log() {}}, api: 'fixture',
    SessionDiagnostics: {finish: record('finish'), note: record('note')},
    stopVideoPresentationObserver: record('stop video observer'),
    stopAudioScheduler: record('stop audio'),
    snackbarLogLong: record('snackbar'), showApps: record('show apps'),
    setTimeout: record('timer'),
    $(selector) {
      return {
        css: (...args) => trace.push(['css', selector, ...args]),
        removeClass: (...args) => trace.push(['removeClass', selector, ...args]),
        text: (...args) => trace.push(['text', selector, ...args])
      };
    }
  };
  vm.runInNewContext(code, context);
  context.handleMessage(message);
  // Timer callbacks are not executed here; compare their source and delay.
  return JSON.parse(JSON.stringify(trace, (key, value) => typeof value === 'function' ? value.toString() : value));
}
for (const message of [
  ...[0, -100, -101, -102, -103, -104, -999].map(code => 'streamTerminated: ' + code),
  'WarningMsg: Video stream unstable. Check connection or settings.',
  'NoWarningMsg: Connection to PC has been improved.',
  'DecoderError: Synthetic error', 'ProgressMsg: Synthetic progress'
]) {
  const expected = dispatch(oldMessages, message);
  if (message === 'streamTerminated: -101') {
    const snackbar = expected.find(event => event[0] === 'snackbar');
    assert.strictEqual(snackbar[1], "Your network connection isn't performing well. Reduce your video bitrate setting or try a faster connection.");
    snackbar[1] = 'Stream ended. Check connection or settings.';
  }
  assert.deepStrictEqual(dispatch(newMessages, message), expected, message + ' preserves all non-text effects');
}
console.log('connection_warning_test: receive callback returns before UI work; FIFO and stale-session guards OK');
