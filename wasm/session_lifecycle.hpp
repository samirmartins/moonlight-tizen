#pragma once
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>

namespace mlsession {
enum class Phase { Idle, Starting, Running, Stopping, Blocked };

// The platform callback owns only this ticket, never the instance or a new source.
class CloseTicket {
 public:
  void Complete(bool success) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (done_) return;
    done_ = true;
    success_ = success;
    changed_.notify_all();
  }
  bool Wait(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mutex_);
    changed_.wait_for(lock, timeout, [&] { return done_; });
    return done_ && success_;
  }
  bool Succeeded() {
    std::lock_guard<std::mutex> lock(mutex_);
    return done_ && success_;
  }
 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  bool done_ = false;
  bool success_ = false;
};
constexpr std::chrono::milliseconds kCloseTimeout{3000};
}  // namespace mlsession
