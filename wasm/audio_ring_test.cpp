#include "audio_ring.hpp"

#include <cassert>
#include <cstdint>

int main() {
  AudioPcmRing<8, 2> ring;
  ring.Reset(7, 2, 6);
  assert(ring.control()->generation.load() == 7);
  assert(ring.control()->targetFrames.load() == 2);

  const int16_t first[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
  assert(ring.Push(first, 6, 2));
  assert(ring.control()->writeFrame.load() == 6);
  for (int i = 0; i < 12; i++) {
    assert(ring.data()[i] == first[i]);
  }

  ring.control()->readFrame.store(4);
  const int16_t wrapped[] = {20, 21, 22, 23, 24, 25, 26, 27};
  assert(ring.Push(wrapped, 4, 2));
  assert(ring.control()->writeFrame.load() == 10);
  assert(ring.data()[12] == 20 && ring.data()[13] == 21);
  assert(ring.data()[14] == 22 && ring.data()[15] == 23);
  assert(ring.data()[0] == 24 && ring.data()[1] == 25);
  assert(ring.data()[2] == 26 && ring.data()[3] == 27);

  const uint32_t oldEpoch = ring.control()->epoch.load();
  const int16_t overflow[] = {
    30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41
  };
  assert(!ring.Push(overflow, 6, 2));
  assert(ring.control()->overruns.load() == 1);
  assert(ring.control()->epoch.load() == oldEpoch + 1);
  assert(ring.control()->readFrame.load() == 10);
  assert(ring.control()->writeFrame.load() == 10);
  assert(ring.Push(overflow, 6, 2));
  assert(ring.control()->writeFrame.load() == 16);

  assert(!ring.Push(nullptr, 1, 2));
  assert(!ring.Push(first, 9, 2));
  assert(!ring.Push(first, 1, 3));
  return 0;
}
