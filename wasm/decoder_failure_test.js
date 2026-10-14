'use strict';
// Compile the production startup wait and pipeline-error callback. A real
// condition variable covers readiness, cancellation, error wakeup and timeout.
const fs = require('fs'), cp = require('child_process'), path = require('path'), assert = require('assert');
const source = fs.readFileSync('wasm/wasmplayer.cpp', 'utf8');
function method(marker) {
 const start = source.indexOf(marker); assert(start >= 0);
 let end = source.indexOf('{', start) + 1, depth = 1;
 while (depth) { const c = source[end++]; if (c === '{') depth++; else if (c === '}') depth--; assert(end <= source.length); }
 return source.slice(start, end);
}
assert.match(source, /m_DecoderActive = true;/);
assert.match(source, /m_DecoderActive = false;/);
assert.match(source, /m_DecoderPipelineFailed = false;/);
const fixture = `
#include <atomic>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <chrono>
#include <thread>
#include <string>
#include <cassert>
namespace samsung { namespace wasm { enum class MediaPipelineError { kFixture }; } }
int messages = 0;
void ClLogMessage(const char*, ...) {}
void PostToJs(std::string message) { assert(message.find("DecoderError: ") == 0); ++messages; }
class MoonlightInstance {
public:
 std::mutex m_Mutex;
 std::condition_variable m_EmssStateChanged, m_EmssVideoStateChanged;
 std::atomic<bool> m_DecoderActive{true}, m_ConnectionCancelled{false}, m_DecoderPipelineFailed{false}, m_VideoStarted{false};
 int stops = 0;
 void StopConnection() { ++stops; m_ConnectionCancelled = true; }
 bool WaitFor(std::condition_variable*, std::function<bool()>);
 class SourceListener {
 public:
  MoonlightInstance* m_Instance;
  void OnPipelineError(samsung::wasm::MediaPipelineError, const char*);
 };
};
`;
const tests = `
int main() {
 using Clock = std::chrono::steady_clock;
 const auto error = samsung::wasm::MediaPipelineError::kFixture;
 { // Codec-independent callback/wait contract; setup is tested separately.
  MoonlightInstance app; MoonlightInstance::SourceListener listener{&app}; bool ready = false;
  std::thread signal([&] { std::lock_guard<std::mutex> lock(app.m_Mutex); ready = true; app.m_EmssStateChanged.notify_all(); });
  assert(app.WaitFor(&app.m_EmssStateChanged, [&] { return ready; })); signal.join();
  ready = false;
  std::thread fail([&] { listener.OnPipelineError(error, nullptr); });
  assert(!app.WaitFor(&app.m_EmssStateChanged, [&] { return ready; })); fail.join();
  assert(app.stops == 0 && app.m_DecoderPipelineFailed);
  app.m_DecoderPipelineFailed = false; app.m_VideoStarted = true;
  listener.OnPipelineError(error, nullptr); assert(app.stops == 1 && app.m_ConnectionCancelled);
  const int before = messages; listener.OnPipelineError(error, nullptr); assert(app.stops == 1 && messages == before);
 }
 MoonlightInstance during;
 std::thread cancel([&] { std::this_thread::sleep_for(std::chrono::milliseconds(20)); during.m_ConnectionCancelled = true; during.m_EmssStateChanged.notify_all(); });
 assert(during.WaitFor(&during.m_EmssStateChanged, [] { return false; })); cancel.join();
 MoonlightInstance cancelled; cancelled.m_ConnectionCancelled = true;
 assert(cancelled.WaitFor(&cancelled.m_EmssStateChanged, [] { return false; }));
 MoonlightInstance inactive; inactive.m_DecoderActive = false;
 MoonlightInstance::SourceListener listener{&inactive}; const int before = messages;
 listener.OnPipelineError(error, nullptr); assert(messages == before && !inactive.m_DecoderPipelineFailed);
 MoonlightInstance timeout; const auto start = Clock::now();
 assert(!timeout.WaitFor(&timeout.m_EmssVideoStateChanged, [] { return false; }));
 const double seconds = std::chrono::duration<double>(Clock::now() - start).count();
 assert(seconds >= 15.0 && seconds < 20.0);
 return 0;
}
`;
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'moonlight-decoder-test-'));
try {
 const file = path.join(tmp, 'test.cpp'), bin = path.join(tmp, 'test');
 fs.writeFileSync(file, fixture + method('void MoonlightInstance::SourceListener::OnPipelineError(') +
   '\n' + method('bool MoonlightInstance::WaitFor(') + tests);
 cp.execFileSync('g++', ['-std=c++17', '-O1', '-g', '-pthread', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', file, '-o', bin], {stdio: 'inherit'});
 cp.execFileSync(bin, [], {stdio: 'inherit', timeout: 25000, env: {...process.env, ASAN_OPTIONS: 'detect_leaks=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
console.log('decoder_failure_test: production readiness/error/cancellation/15-second timeout and inactive guard OK');
