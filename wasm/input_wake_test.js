'use strict';
// Exercise the production input wait with real threads and Linux compare-and-wait.
const fs = require('fs'), cp = require('child_process'), path = require('path'), assert = require('assert');
const source = fs.readFileSync('wasm/gamepad.cpp', 'utf8');
const start = source.indexOf('void NotifyInputEvent()');
const end = source.indexOf('bool InputNeedsTimedWake()', start);
assert(start > 0 && end > start);
const methods = source.slice(start, end);
assert.match(methods, /emscripten_futex_wait/);
assert.doesNotMatch(methods, /condition_variable|wait_for|sleep_for/);
const main = fs.readFileSync('wasm/main.cpp', 'utf8');
const loopStart = main.indexOf('void* MoonlightInstance::InputThreadFunc(');
const loopEnd = main.indexOf('void* MoonlightInstance::ConnectionThreadFunc(', loopStart);
assert(loopStart > 0 && loopEnd > loopStart);
const sanitizer = process.env.ML_INPUT_WAKE_SANITIZER || 'address,undefined';
assert(['address,undefined', 'thread'].includes(sanitizer));
const fixture = `
#include <atomic>
#include <cassert>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <thread>
#include <vector>
#include <linux/futex.h>
#include <sys/syscall.h>
#include <unistd.h>
using Clock = std::chrono::steady_clock;
alignas(4) static uint32_t s_inputWakeGeneration = 0;
static std::atomic<int> waitCalls{0}, wakeCalls{0}, mismatchReturns{0};
static std::atomic<bool> forceGap{false}, gapEntered{false}, gapRelease{false};
static std::atomic<bool> timedWake{false};
template<class Predicate> void Await(Predicate done) {
  auto deadline = Clock::now() + std::chrono::seconds(3);
  while (!done()) { assert(Clock::now() < deadline); std::this_thread::yield(); }
}
int emscripten_futex_wait(volatile void* address, uint32_t value, double ms) {
  waitCalls++;
  if (forceGap.exchange(false)) {
    gapEntered = true;
    Await([] { return gapRelease.load(); });
  }
  timespec duration{};
  timespec* limit = nullptr;
  if (std::isfinite(ms)) {
    const auto ns = static_cast<int64_t>(ms * 1000000.0);
    duration.tv_sec = ns / 1000000000;
    duration.tv_nsec = ns % 1000000000;
    limit = &duration;
  }
  auto* word = const_cast<uint32_t*>(static_cast<volatile uint32_t*>(address));
  int result = syscall(SYS_futex, word, FUTEX_WAIT_PRIVATE, value, limit, nullptr, 0);
  if (result < 0 && errno == EAGAIN) mismatchReturns++;
  return result;
}
int emscripten_futex_wake(volatile void* address, int count) {
  wakeCalls++;
  auto* word = const_cast<uint32_t*>(static_cast<volatile uint32_t*>(address));
  return syscall(SYS_futex, word, FUTEX_WAKE_PRIVATE, count, nullptr, nullptr, 0);
}
${methods}
bool InputNeedsTimedWake() { return timedWake.load(); }
class MoonlightInstance {
public:
  std::atomic<bool> m_Running{true};
  std::atomic<unsigned> polls{0}, mouseReports{0};
  void PollGamepads() { polls++; }
  void ReportMouseMovement() { mouseReports++; }
  static void* InputThreadFunc(void*);
};
${main.slice(loopStart, loopEnd)}
int main() {
  // Already-published events never enter a wait, even with an infinite timeout.
  uint32_t observed = __atomic_load_n(&s_inputWakeGeneration, __ATOMIC_ACQUIRE);
  auto previousWaits = waitCalls.load();
  NotifyInputEvent(); WaitForInputEvent(observed, -1);
  assert(waitCalls == previousWaits && observed == 1);
  // Force the exact old lost-notification window, both indefinite and timed.
  for (int i = 0; i < 100; ++i) {
    gapEntered = false; gapRelease = false; forceGap = true;
    const auto before = observed;
    std::atomic<bool> done{false};
    std::thread worker([&] { WaitForInputEvent(observed, i % 2 ? 8 : -1); done = true; });
    Await([] { return gapEntered.load(); });
    NotifyInputEvent(); gapRelease = true;
    Await([&] { return done.load(); }); worker.join();
    assert(observed == before + 1);
  }
  assert(mismatchReturns == 100);
  // The existing 8 ms timed mode still expires without manufacturing an event.
  auto begin = Clock::now(); const auto unchanged = observed;
  WaitForInputEvent(observed, 8);
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - begin).count();
  assert(elapsed >= 7 && elapsed < 1000 && observed == unchanged);
  WaitForInputEvent(observed, 0); assert(observed == unchanged);
  // Idle worker sleeps without polling; snapshot/mouse and stop wake it.
  for (int session = 0; session < 20; ++session) {
    MoonlightInstance app;
    std::atomic<bool> done{false};
    std::thread worker([&] { MoonlightInstance::InputThreadFunc(&app); done = true; });
    Await([&] { return app.polls.load() >= 2; });
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
  const auto idle = app.polls.load(); const auto waits = waitCalls.load();
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    assert(app.polls == idle && waitCalls == waits);
    NotifyInputEvent(); Await([&] { return app.polls.load() > idle; });
    timedWake = true; NotifyInputEvent();
    const auto beforeTimed = app.polls.load();
    Await([&] { return app.polls.load() > beforeTimed + 1; });
    timedWake = false;
    app.m_Running = false; NotifyInputEvent();
    Await([&] { return done.load(); }); worker.join();
    assert(app.mouseReports == app.polls);
  }
  // Concurrent mouse/snapshot/stop publishers keep the generation coherent.
  std::atomic<bool> running{true}, done{false};
  std::thread worker([&] { while (running) WaitForInputEvent(observed, -1); done = true; });
  std::vector<std::thread> producers;
  for (int p = 0; p < 4; ++p) producers.emplace_back([] { for (int i = 0; i < 1000; ++i) NotifyInputEvent(); });
  for (auto& producer : producers) producer.join();
  running = false; NotifyInputEvent();
  Await([&] { return done.load(); }); worker.join();
  std::cout << "native input wake: 100 forced gaps, idle/timed/stop/restart and concurrent publishers passed\\n";
}
`;
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'moonlight-input-wake-'));
try {
  const file = path.join(tmp, 'test.cpp'), bin = path.join(tmp, 'test');
  fs.writeFileSync(file, fixture);
  cp.execFileSync('g++', ['-std=c++17', '-O1', '-g', '-pthread', '-fsanitize=' + sanitizer,
    '-fno-omit-frame-pointer', file, '-o', bin], {stdio: 'inherit'});
  cp.execFileSync(bin, [], {stdio: 'inherit', timeout: 15000});
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
console.log('input_wake_test: production wait/worker, lost-wake interleaving and no idle polling OK');
