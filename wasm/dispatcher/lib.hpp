#ifndef __DISPATCHER_LIB_HPP
#define __DISPATCHER_LIB_HPP

#include <condition_variable>
#include <functional>
#include <mutex>
#include <queue>
#include <thread>
#include <utility>

class Dispatcher {
 public:
  Dispatcher() = default;
  ~Dispatcher() { stop(); }

  Dispatcher(const Dispatcher&) = delete;
  Dispatcher& operator=(const Dispatcher&) = delete;

  void start() {
    if (!thread_.joinable()) {
      thread_ = std::thread([this] { run(); });
    }
  }

  void stop() {
    if (!thread_.joinable()) {
      return;
    }
    post_job([] {}, true);
    thread_.join();
  }

  template<class Callable, typename... Ts>
  void post_job(Callable&& fn, bool end, Ts&&... ts) {
    Entry entry;
    entry.func = std::bind(std::forward<Callable>(fn), std::forward<Ts>(ts)...);
    entry.end = end;

    {
      std::lock_guard<std::mutex> lock(mutex_);
      queue_.emplace(std::move(entry));
    }
    cv_.notify_one();
  }

 private:
  struct Entry {
    std::function<void()> func;
    bool end = false;
  };

  void run() {
    for (;;) {
      Entry entry;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, [this] { return !queue_.empty(); });
        entry = std::move(queue_.front());
        queue_.pop();
      }

      if (entry.end) {
        return;
      }
      entry.func();
    }
  }

  std::queue<Entry> queue_;
  std::mutex mutex_;
  std::condition_variable cv_;
  std::thread thread_;
};

#endif
