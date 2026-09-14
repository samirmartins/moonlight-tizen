#pragma once

#include <atomic>
#include <cmath>
#include <algorithm>
#include <cstdint>

namespace mlvideo {
struct PositionSample {
  int64_t positionUs = -1;
  uint64_t atMs = 0;
};

// Atomic payloads avoid C++ data races; a sequence prevents mixing generations.
// Bounded readers/writers skip a contended sample instead of delaying playback.
class PositionClock {
  std::atomic<uint32_t> sequence_{0};
  std::atomic<int64_t> position_{-1};
  std::atomic<uint64_t> at_{0};
public:
  bool Store(int64_t position, uint64_t at) {
    auto sequence = sequence_.load();
    if ((sequence & 1) || !sequence_.compare_exchange_strong(sequence, sequence + 1)) return false;
    position_.store(position);
    at_.store(at);
    sequence_.store(sequence + 2);
    return true;
  }
  PositionSample Read() const {
    for (int attempt = 0; attempt < 3; ++attempt) {
      const auto before = sequence_.load();
      if (before & 1) continue;
      PositionSample sample{position_.load(), at_.load()};
      if (before == sequence_.load()) return sample;
    }
    return {};
  }
};

class CalibrationRetry {
  unsigned valid_ = 0;
  bool attempted_ = false;
public:
  void Reset() { valid_ = 0; attempted_ = false; }
  bool Ready(int samples, double filtered, double raw) {
    if (samples < 1800) return false;
    const bool valid = std::isfinite(filtered) && filtered >= 2.0 && filtered <= 200.0;
    // Preserve the original first calibration opportunity.
    if (!attempted_) { attempted_ = true; return valid; }
    if (!valid || !std::isfinite(raw) || raw < 2.0 || raw > 200.0) { valid_ = 0; return false; }
    return ++valid_ >= 60;
  }
};

} // namespace mlvideo
