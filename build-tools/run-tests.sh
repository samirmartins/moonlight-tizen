#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
for command in node gcc g++ ffmpeg git; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command" >&2; exit 1; }
done
for reference in v3.3.8 v3.3.10; do
  git rev-parse --verify "$reference^{commit}" >/dev/null || {
    echo "Missing baseline tag $reference. Fetch tags and full history before testing." >&2
    exit 1
  }
done

# Includes the existing H.264 pixel comparison and certificate resource tests.
for test in wasm/*_test.js; do
  echo "Running $test"
  node "$test"
done

test_directory=$(mktemp -d)
trap 'rm -rf "$test_directory"' EXIT
export ASAN_OPTIONS=detect_leaks=1
export UBSAN_OPTIONS=halt_on_error=1
for test in audio_ring dispatcher video_timing video_telemetry wakeonlan; do
  echo "Running ${test}_test.cpp"
  g++ -std=c++17 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
    -pthread -Iwasm "wasm/${test}_test.cpp" -o "$test_directory/$test"
  "$test_directory/$test"
done
echo 'All JavaScript and standalone native tests passed.'
