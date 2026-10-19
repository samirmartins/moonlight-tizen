#pragma once

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
#include <arpa/inet.h>
#include <netdb.h>

namespace mlhttp {
using Clock = std::chrono::steady_clock;
struct Address { std::string text; uint32_t scope = 0; };

struct Request {
  int id;
  int cancelled = 0; // Accessed with atomics; also passed to the C curl callback.
  Clock::time_point deadline;
  bool active() const {
    return !__atomic_load_n(&cancelled, __ATOMIC_RELAXED) && Clock::now() < deadline;
  }
  int remaining() const {
    return active() ? static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
      deadline - Clock::now()).count()) : 0;
  }
};

// The SDK's synchronous resolver cannot be interrupted safely. Isolate at most
// one native call, never one thread per attempt. Callers have independent waits;
// numeric endpoints do not use this worker. No DNS results are cached globally.
class Resolver {
 public:
  using Lookup = std::function<std::vector<Address>(const std::string&)>;
  static std::vector<Address> lookup(const std::string& host) {
    addrinfo hints{}; hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    addrinfo* head = nullptr;
    if (getaddrinfo(host.c_str(), nullptr, &hints, &head)) return {};
    std::unique_ptr<addrinfo, decltype(&freeaddrinfo)> owner(head, freeaddrinfo);
    std::vector<Address> addresses;
    for (auto* p = head; p && addresses.size() < 16; p = p->ai_next) {
      char text[INET6_ADDRSTRLEN]{};
      const void* raw = nullptr;
      uint32_t scope = 0;
      if (p->ai_family == AF_INET) raw = &reinterpret_cast<sockaddr_in*>(p->ai_addr)->sin_addr;
      else if (p->ai_family == AF_INET6) {
        const auto* ipv6 = reinterpret_cast<sockaddr_in6*>(p->ai_addr);
        raw = &ipv6->sin6_addr; scope = ipv6->sin6_scope_id;
      }
      if (raw && inet_ntop(p->ai_family, raw, text, sizeof(text)) &&
          std::none_of(addresses.begin(), addresses.end(), [&](const Address& a) {
            return a.text == text && a.scope == scope;
          })) addresses.push_back({text, scope});
    }
    return addresses;
  }
  explicit Resolver(Lookup lookupFn = lookup) : state_(std::make_shared<State>(std::move(lookupFn))) {}
  ~Resolver() { stop(); }
  void notify() {
    std::lock_guard<std::mutex> lock(state_->mutex);
    state_->cv.notify_all();
  }
  std::vector<Address> resolve(const std::string& host, const Request& request) {
    auto s = state_;
    auto job = std::make_shared<Query>(); job->host = host;
    std::unique_lock<std::mutex> lock(s->mutex);
    if (s->stopping || !request.active()) return {};
    // Two lanes can wait; a timed-out queued query is removed, not accumulated.
    if (s->queue.size() >= 2) return {};
    if (!worker_.joinable()) worker_ = std::thread([s] {
      std::unique_lock<std::mutex> guard(s->mutex);
      for (;;) {
        s->cv.wait(guard, [&] { return s->stopping || !s->queue.empty(); });
        if (s->stopping) return;
        auto query = s->queue.front(); s->queue.pop_front();
        guard.unlock();
        auto addresses = s->lookup(query->host);
        guard.lock();
        query->addresses = std::move(addresses); query->done = true;
        s->cv.notify_all();
      }
    });
    s->queue.push_back(job); s->cv.notify_all();
    s->cv.wait_until(lock, request.deadline, [&] {
      return s->stopping || !request.active() || job->done;
    });
    s->queue.erase(std::remove(s->queue.begin(), s->queue.end(), job), s->queue.end());
    return !s->stopping && request.active() && job->done ? std::move(job->addresses) : std::vector<Address>{};
  }
  void stop() {
    {
      std::lock_guard<std::mutex> lock(state_->mutex);
      state_->stopping = true; state_->queue.clear();
    }
    state_->cv.notify_all();
    // Only the resolver state is captured, never an instance/request buffer.
    // A platform call still in progress may outlive shutdown, but cannot touch
    // a destroyed transport or publish a reply. There is at most one such call.
    if (worker_.joinable()) worker_.detach();
  }
 private:
  struct Query { std::string host; bool done = false; std::vector<Address> addresses; };
  struct State {
    explicit State(Lookup fn) : lookup(std::move(fn)) {}
    std::mutex mutex; std::condition_variable cv; bool stopping = false;
    std::deque<std::shared_ptr<Query>> queue; Lookup lookup;
  };
  std::shared_ptr<State> state_;
  std::thread worker_;
};

struct Result {
  bool ok = false;
  std::string text;
  std::vector<uint8_t> bytes;
};

// Menu-only lanes: metadata cannot queue behind artwork, nor can either queue
// occupy the legacy launch/pair dispatcher. All threads sleep when idle.
class Transport {
 public:
  using Work = std::function<Result(const Request&)>;
  using Done = std::function<void(Result)>;
  Resolver resolver;
  ~Transport() { stop(); }
  void submit(int id, bool artwork, int timeoutMs, Work work, Done done) {
    auto job = std::make_shared<Job>();
    job->request.id = id;
    job->request.deadline = Clock::now() + std::chrono::milliseconds(std::max(1, std::min(timeoutMs, 10000)));
    job->work = std::move(work); job->done = std::move(done);
    const int lane = artwork ? 1 : 0;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      if (stopping_ || jobs_.size() >= 32 || jobs_.count(id)) {
        lock.unlock(); job->done({false, "Menu request unavailable.", {}}); return;
      }
      if (!timer_.joinable()) timer_ = std::thread([this] { expire(); });
      if (!workers_[lane].joinable()) workers_[lane] = std::thread([this, lane] { run(lane); });
      jobs_.emplace(id, job); queues_[lane].push_back(job);
    }
    cv_.notify_all();
  }
  void cancel(int id) {
    Done done;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      const auto it = jobs_.find(id);
      if (it == jobs_.end()) return;
      done = retire(it->second);
    }
    resolver.notify(); cv_.notify_all();
    done({false, "Menu request cancelled or expired.", {}});
  }
  void stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
      for (auto& item : jobs_) __atomic_store_n(&item.second->request.cancelled, 1, __ATOMIC_RELAXED);
      jobs_.clear(); queues_[0].clear(); queues_[1].clear();
    }
    resolver.notify(); cv_.notify_all();
    for (auto& worker : workers_) if (worker.joinable()) worker.join();
    if (timer_.joinable()) timer_.join();
    resolver.stop();
  }
 private:
  struct Job { Request request; Work work; Done done; };
  // Caller holds mutex_. The active worker retains ownership of its buffers.
  Done retire(std::shared_ptr<Job> job) {
    __atomic_store_n(&job->request.cancelled, 1, __ATOMIC_RELAXED);
    jobs_.erase(job->request.id);
    for (auto& queue : queues_) queue.erase(std::remove(queue.begin(), queue.end(), job), queue.end());
    return std::move(job->done);
  }
  void run(int lane) {
    std::unique_lock<std::mutex> lock(mutex_);
    for (;;) {
      cv_.wait(lock, [&] { return stopping_ || !queues_[lane].empty(); });
      if (stopping_) return;
      auto job = queues_[lane].front(); queues_[lane].pop_front();
      lock.unlock();
      Result result;
      if (job->request.active()) result = job->work(job->request);
      lock.lock();
      const auto it = jobs_.find(job->request.id);
      if (it != jobs_.end() && it->second == job) {
        if (!job->request.active()) result = {false, "Menu request cancelled or expired.", {}};
        auto done = retire(job);
        lock.unlock(); done(std::move(result)); cv_.notify_all(); lock.lock();
      }
    }
  }
  void expire() {
    std::unique_lock<std::mutex> lock(mutex_);
    for (;;) {
      if (stopping_) return;
      if (jobs_.empty()) { cv_.wait(lock); continue; }
      auto next = std::min_element(jobs_.begin(), jobs_.end(), [](const auto& a, const auto& b) {
        return a.second->request.deadline < b.second->request.deadline;
      });
      const auto deadline = next->second->request.deadline;
      if (Clock::now() < deadline) { cv_.wait_until(lock, deadline); continue; }
      auto done = retire(next->second);
      lock.unlock(); resolver.notify(); done({false, "Menu request cancelled or expired.", {}}); lock.lock();
    }
  }
  std::mutex mutex_; std::condition_variable cv_;
  bool stopping_ = false;
  std::unordered_map<int, std::shared_ptr<Job>> jobs_;
  std::deque<std::shared_ptr<Job>> queues_[2];
  std::thread workers_[2], timer_;
};
} // namespace mlhttp
