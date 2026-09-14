#include "video_timing.hpp"
#include <cassert>
#include <thread>
#include <vector>
#include <iostream>

int main() {
  mlvideo::PositionClock clock;
  assert(clock.Read().positionUs == -1);
  std::atomic<bool> done{false};
  std::vector<std::thread> readers;
  for (int r=0;r<4;r++) readers.emplace_back([&] {
    while (!done.load()) {
      const auto s=clock.Read();
      assert(s.positionUs == -1 || s.positionUs == static_cast<int64_t>(s.atMs*1000));
    }
  });
  std::thread second([&]{for(uint64_t i=1;i<=50000;i++)clock.Store(i*1000,i);});
  for(uint64_t i=50001;i<=100000;i++)clock.Store(i*1000,i);
  second.join();done.store(true);for(auto& t:readers)t.join();
  assert(clock.Store(0,0));assert(clock.Read().positionUs==0);

  mlvideo::CalibrationRetry c;
  for(int n=1;n<1800;n++)assert(!c.Ready(n,15,15));
  assert(c.Ready(1800,15,15));
  c.Reset();assert(!c.Ready(1800,0,0));
  for(int i=0;i<59;i++)assert(!c.Ready(1800,15,15));
  assert(!c.Ready(1800,15,-1)); // invalid sample restarts confirmation
  for(int i=0;i<59;i++)assert(!c.Ready(1800,15,15));
  assert(c.Ready(1800,15,15));
  c.Reset();assert(!c.Ready(1800,NAN,15));

  std::cout<<"video_timing_test: coherent concurrent snapshots and calibration retry OK\n";
}
