#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace mltelemetry {

// Two four-second windows at 60 FPS fit with room to spare. Samples exist only
// while the user has explicitly enabled the performance overlay.
constexpr uint16_t kSeriesCapacity = 512;

struct Series {
  uint16_t count;
  uint32_t values[kSeriesCapacity];
};

struct Summary {
  double mean;
  double deviation;
  double p95;
  double maximum;
};

inline void Add(Series& series, uint32_t value) {
  if (series.count < kSeriesCapacity) {
    series.values[series.count++] = value;
  }
}

inline void Merge(const Series& source, Series& destination) {
  const uint16_t room = kSeriesCapacity - destination.count;
  const uint16_t copy = std::min(room, source.count);
  if (copy != 0) {
    std::memcpy(&destination.values[destination.count], source.values,
                copy * sizeof(source.values[0]));
    destination.count += copy;
  }
}

inline Summary Summarize(const Series& series, double divisor = 1.0) {
  Summary result{};
  if (series.count == 0 || divisor <= 0.0) {
    return result;
  }

  std::array<uint32_t, kSeriesCapacity> sorted{};
  uint64_t sum = 0;
  long double sumSq = 0.0;
  for (uint16_t i = 0; i < series.count; ++i) {
    const uint32_t value = series.values[i];
    sorted[i] = value;
    sum += value;
    sumSq += static_cast<long double>(value) * value;
  }
  std::sort(sorted.begin(), sorted.begin() + series.count);

  const double rawMean = static_cast<double>(sum) / series.count;
  long double variance = sumSq / series.count -
                         static_cast<long double>(rawMean) * rawMean;
  if (variance < 0.0) {
    variance = 0.0;
  }
  const uint16_t p95Index = static_cast<uint16_t>(
    std::ceil(series.count * 0.95) - 1);

  result.mean = rawMean / divisor;
  result.deviation = std::sqrt(static_cast<double>(variance)) / divisor;
  result.p95 = sorted[p95Index] / divisor;
  result.maximum = sorted[series.count - 1] / divisor;
  return result;
}

struct HitchTracker {
  uint64_t enabledAtUs;
  uint64_t lastEventUs;
  uint32_t events;
  uint32_t currentBurst;
  uint32_t maxBurst;
  bool inBurst;
  Series periodsUs;
};

inline void Reset(HitchTracker& tracker, uint64_t nowUs) {
  std::memset(&tracker, 0, sizeof(tracker));
  tracker.enabledAtUs = nowUs;
}

inline void Observe(HitchTracker& tracker, bool late, uint64_t nowUs) {
  if (!late) {
    tracker.inBurst = false;
    tracker.currentBurst = 0;
    return;
  }

  if (tracker.inBurst) {
    tracker.currentBurst++;
    tracker.maxBurst = std::max(tracker.maxBurst, tracker.currentBurst);
    return;
  }

  tracker.inBurst = true;
  tracker.currentBurst = 1;
  tracker.maxBurst = std::max(tracker.maxBurst, tracker.currentBurst);
  tracker.events++;
  if (tracker.lastEventUs != 0 && nowUs > tracker.lastEventUs) {
    const uint64_t periodUs = nowUs - tracker.lastEventUs;
    Add(tracker.periodsUs, static_cast<uint32_t>(
      std::min<uint64_t>(periodUs, UINT32_MAX)));
  }
  tracker.lastEventUs = nowUs;
}

inline double EventsPerMinute(const HitchTracker& tracker, uint64_t nowUs) {
  if (tracker.enabledAtUs == 0 || nowUs <= tracker.enabledAtUs) {
    return 0.0;
  }
  const double elapsedMinutes =
    static_cast<double>(nowUs - tracker.enabledAtUs) / 60000000.0;
  return elapsedMinutes > 0.0 ? tracker.events / elapsedMinutes : 0.0;
}

}  // namespace mltelemetry
