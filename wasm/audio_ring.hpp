#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>

// Shared control block for the decoded PCM ring.
//
// This structure is read directly by AudioWorklet JavaScript through an
// Int32Array. Keep every field 32-bit wide and append new fields rather than
// reordering existing ones. The matching indexes live in
// platform/audio-worklet.js and platform/audio.js.
struct AudioRingControl {
  std::atomic<uint32_t> readFrame;       // 0
  std::atomic<uint32_t> writeFrame;      // 1
  std::atomic<uint32_t> generation;      // 2
  std::atomic<int32_t> mode;             // 3: 0=waiting, 1=worklet, 2=fallback, 3=stopped
  std::atomic<uint32_t> underruns;       // 4
  std::atomic<uint32_t> overruns;        // 5
  std::atomic<uint32_t> targetFrames;    // 6: adaptive target currently in force
  std::atomic<uint32_t> minDepthFrames;  // 7
  std::atomic<uint32_t> maxDepthFrames;  // 8
  std::atomic<uint32_t> consumedFrames;  // 9: source/content frames rendered
  std::atomic<int32_t> driftPpm;         // 10: A/V correction from the main thread
  std::atomic<uint32_t> started;         // 11: output passed the initial prebuffer
  std::atomic<uint32_t> epoch;           // 12: changes when producer must reset the ring
  std::atomic<uint32_t> initialTarget;   // 13: low-latency target after a stable period
  std::atomic<uint32_t> maximumTarget;   // 14: ceiling selected by the user
  std::atomic<uint32_t> reserved;        // 15
};

static_assert(sizeof(std::atomic<uint32_t>) == sizeof(uint32_t),
              "WASM atomics must remain 32-bit for JavaScript interop");
static_assert(sizeof(AudioRingControl) == 16 * sizeof(uint32_t),
              "AudioRingControl layout changed; update the JavaScript indexes");

template <size_t CapacityFrames, size_t MaxChannels>
class AudioPcmRing {
 public:
  static_assert(CapacityFrames != 0 &&
                  (CapacityFrames & (CapacityFrames - 1)) == 0,
                "PCM ring capacity must be a power of two");

  AudioPcmRing() { Reset(0, 0, 0); }

  void Reset(uint32_t generation, uint32_t initialTarget,
             uint32_t maximumTarget) {
    control_.readFrame.store(0, std::memory_order_relaxed);
    control_.writeFrame.store(0, std::memory_order_relaxed);
    control_.generation.store(generation, std::memory_order_relaxed);
    control_.mode.store(0, std::memory_order_relaxed);
    control_.underruns.store(0, std::memory_order_relaxed);
    control_.overruns.store(0, std::memory_order_relaxed);
    control_.targetFrames.store(initialTarget, std::memory_order_relaxed);
    control_.minDepthFrames.store(UINT32_MAX, std::memory_order_relaxed);
    control_.maxDepthFrames.store(0, std::memory_order_relaxed);
    control_.consumedFrames.store(0, std::memory_order_relaxed);
    control_.driftPpm.store(0, std::memory_order_relaxed);
    control_.started.store(0, std::memory_order_relaxed);
    control_.epoch.fetch_add(1, std::memory_order_relaxed);
    control_.initialTarget.store(initialTarget, std::memory_order_relaxed);
    control_.maximumTarget.store(maximumTarget, std::memory_order_relaxed);
    control_.reserved.store(0, std::memory_order_relaxed);
  }

  // SPSC producer. The decoder feeder is the only writer and the audio backend
  // is the only reader. A reset is preferable to parking a full second of old
  // sound in front of the user if the consumer ever falls that far behind.
  bool Push(const int16_t* interleaved, uint32_t frames, uint32_t channels) {
    if (interleaved == nullptr || frames == 0 || channels == 0 ||
        channels > MaxChannels || frames > CapacityFrames) {
      return false;
    }

    uint32_t write = control_.writeFrame.load(std::memory_order_relaxed);
    uint32_t read = control_.readFrame.load(std::memory_order_acquire);
    uint32_t used = write - read;
    if (used > CapacityFrames || used + frames > CapacityFrames) {
      control_.overruns.fetch_add(1, std::memory_order_relaxed);
      control_.readFrame.store(write, std::memory_order_release);
      control_.started.store(0, std::memory_order_release);
      // Publish the epoch last. A consumer that observes it is then guaranteed
      // to observe the matching read pointer and stopped prebuffer state too.
      control_.epoch.fetch_add(1, std::memory_order_acq_rel);
      // Drop this one frame. Writing it immediately could overwrite samples an
      // audio quantum had already selected before it saw the new epoch. The
      // next Opus frame arrives about 10 ms later, after several worklet
      // quanta, and starts the fresh prebuffer without that producer/consumer
      // collision.
      return false;
    }

    const uint32_t offset = write & (CapacityFrames - 1);
    const uint32_t firstFrames =
      std::min<uint32_t>(frames, static_cast<uint32_t>(CapacityFrames) - offset);
    const size_t firstSamples = static_cast<size_t>(firstFrames) * channels;
    std::memcpy(&pcm_[static_cast<size_t>(offset) * channels], interleaved,
                firstSamples * sizeof(int16_t));

    const uint32_t remainingFrames = frames - firstFrames;
    if (remainingFrames != 0) {
      const size_t remainingSamples =
        static_cast<size_t>(remainingFrames) * channels;
      std::memcpy(&pcm_[0], &interleaved[firstSamples],
                  remainingSamples * sizeof(int16_t));
    }

    control_.writeFrame.store(write + frames, std::memory_order_release);
    return true;
  }

  AudioRingControl* control() { return &control_; }
  int16_t* data() { return pcm_; }
  static constexpr uint32_t capacity_frames() {
    return static_cast<uint32_t>(CapacityFrames);
  }

 private:
  alignas(64) AudioRingControl control_{};
  alignas(64) int16_t pcm_[CapacityFrames * MaxChannels]{};
};
