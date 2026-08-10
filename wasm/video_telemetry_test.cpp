#include "video_telemetry.hpp"

#include <cassert>
#include <cmath>
#include <iostream>

int main() {
  mltelemetry::Series first{};
  mltelemetry::Series second{};
  mltelemetry::Add(first, 1000);
  mltelemetry::Add(first, 2000);
  mltelemetry::Add(second, 3000);
  mltelemetry::Merge(second, first);

  const auto summary = mltelemetry::Summarize(first, 1000.0);
  assert(first.count == 3);
  assert(std::abs(summary.mean - 2.0) < 0.001);
  assert(summary.p95 == 3.0);
  assert(summary.maximum == 3.0);

  mltelemetry::HitchTracker hitches{};
  mltelemetry::Reset(hitches, 1000000);
  mltelemetry::Observe(hitches, true, 2000000);
  mltelemetry::Observe(hitches, true, 2010000);  // same burst
  mltelemetry::Observe(hitches, false, 2020000);
  mltelemetry::Observe(hitches, true, 7000000);
  assert(hitches.events == 2);
  assert(hitches.maxBurst == 2);
  assert(hitches.periodsUs.count == 1);
  assert(hitches.periodsUs.values[0] == 5000000);
  assert(std::abs(mltelemetry::EventsPerMinute(hitches, 7000000) - 20.0) < 0.001);

  std::cout << "video_telemetry_test: ok\n";
  return 0;
}
