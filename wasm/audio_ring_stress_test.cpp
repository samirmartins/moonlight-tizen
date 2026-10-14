#include "audio_ring.hpp"
#include <cassert>
#include <thread>
#include <iostream>
int main() {
  for (unsigned channels : {1u, 2u, 6u, 8u}) {
    AudioPcmRing<1024, 8> ring;
    ring.Reset(9, 32, 512);
    auto* c = ring.control();
    const uint32_t origin = UINT32_MAX - 1000, count = 50000;
    c->readFrame.store(origin);
    c->writeFrame.store(origin);
    std::thread consumer([&] {
      for (uint32_t i = 0; i < count; ++i) {
        const uint32_t r = origin + i;
        while (c->writeFrame.load(std::memory_order_acquire) == r) std::this_thread::yield();
        for (unsigned ch = 0; ch < channels; ++ch)
          assert(ring.data()[(r & 1023) * channels + ch] == static_cast<int16_t>((i + ch) % 20000));
        c->readFrame.store(r + 1, std::memory_order_release);
      }
    });
    for (uint32_t i = 0; i < count; ++i) {
      while (static_cast<uint32_t>(origin + i - c->readFrame.load(std::memory_order_acquire)) >= 1024)
        std::this_thread::yield();
      int16_t frame[8];
      for (unsigned ch = 0; ch < channels; ++ch) frame[ch] = (i + ch) % 20000;
      assert(ring.Push(frame, 1, channels));
    }
    consumer.join();
    assert(c->readFrame == origin + count && c->writeFrame == origin + count);
    assert(c->overruns == 0);
    ring.Reset(10, 32, 512);
    assert(c->generation == 10 && c->readFrame == 0 && c->writeFrame == 0);
  }
  std::cout << "audio_ring_stress_test: SPSC concurrency, channel counts and uint32 wrap OK\n";
}
