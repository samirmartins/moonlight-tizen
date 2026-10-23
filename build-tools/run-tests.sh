#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for command in node gcc g++ ffmpeg git timeout; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command" >&2; exit 1; }
done
for reference in v3.3.8 v3.3.10 v3.4.0 v3.4.7 v3.4.9; do
  git rev-parse --verify "$reference^{commit}" >/dev/null || {
    echo "Missing baseline tag $reference. Fetch full history and tags." >&2; exit 1;
  }
done
encoders=$(ffmpeg -hide_banner -encoders 2>/dev/null)
[[ "$encoders" == *libx264* ]] || { echo 'FFmpeg libx264 encoder missing' >&2; exit 1; }
printf '#include <openssl/ssl.h>\n' | g++ -x c++ - -fsyntax-only
test_directory=$(mktemp -d)
trap 'rm -rf "$test_directory"' EXIT
export TMPDIR="$test_directory"
export ASAN_OPTIONS=detect_leaks=1
export UBSAN_OPTIONS=halt_on_error=1
for test in wasm/*_test.js; do
  echo "Running $test"
  ML_TEST_NAME="$(basename "$test" .js)" timeout --kill-after=5s 120s \
    node --unhandled-rejections=strict --require ./build-tools/test-process.cjs "$test"
done
for test in audio_ring audio_ring_stress dispatcher video_timing video_telemetry wakeonlan; do
  echo "Running ${test}_test.cpp"
  timeout --kill-after=5s 90s g++ -std=c++17 -O1 -g \
    -fsanitize=address,undefined -fno-omit-frame-pointer -pthread -Iwasm \
    "wasm/${test}_test.cpp" -o "$test_directory/$test"
  timeout --kill-after=5s 30s "$test_directory/$test"
done
echo 'All core behavioral and scope-contract tests passed; TV and extended checks are separate.'
