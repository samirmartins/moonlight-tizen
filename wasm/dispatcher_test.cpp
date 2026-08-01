#include "dispatcher/lib.hpp"

#include <atomic>
#include <cassert>
#include <future>

int main() {
  Dispatcher dispatcher;
  dispatcher.start();

  std::atomic<int> completed{0};
  std::promise<void> drained;
  for (int i = 0; i < 100; ++i) {
    dispatcher.post_job([&completed] { completed.fetch_add(1); }, false);
  }
  dispatcher.post_job([&drained] { drained.set_value(); }, false);
  drained.get_future().wait();

  assert(completed.load() == 100);
  dispatcher.stop();
  dispatcher.stop();

  dispatcher.start();
  std::promise<void> restarted;
  dispatcher.post_job([&restarted] { restarted.set_value(); }, false);
  restarted.get_future().wait();
  dispatcher.stop();
}
