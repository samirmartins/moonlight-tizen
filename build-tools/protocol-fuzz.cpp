// Optional native parser stress only; never linked into the TV application.
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>
#include <sanitizer/lsan_interface.h>
extern "C" {
#include "Rtsp.h"
}
#include "h264_sps.hpp"

static uint32_t state;
static uint32_t random32() {
  state = state * 1664525u + 1013904223u;
  return state;
}
static std::vector<uint8_t> readFile(const char* name) {
  std::ifstream file(name, std::ios::binary);
  assert(file);
  std::vector<uint8_t> input((std::istreambuf_iterator<char>(file)), {});
  assert(input.size() <= 4096);
  return input;
}
static void check(const std::string& target, std::vector<uint8_t> input) {
  const auto length = input.size();
  // The parser owns a separate mutable buffer; zero-length inputs remain valid pointers.
  input.push_back(0);
  if (target == "rtsp") {
    RTSP_MESSAGE message{};
    if (parseRtspMessage(&message, reinterpret_cast<char*>(input.data()),
                         static_cast<int>(length)) == RTSP_ERROR_SUCCESS) {
      freeMessage(&message);
    }
  } else {
    std::vector<uint8_t> output(length + 64, 0);
    const auto written = mlh264::FixupSps(input.data(), length, output.data(), output.size());
    assert(written <= output.size());
  }
}
int main(int argc, char** argv) {
  assert(argc == 7);
  const std::string target = argv[1];
  assert(target == "rtsp" || target == "h264");
  state = static_cast<uint32_t>(std::strtoul(argv[2], nullptr, 10));
  const int count = std::atoi(argv[3]);
  assert(count > 0 && count <= 100000);
  const auto seed = readFile(argv[4]);
  const bool replay = std::string(argv[6]) == "replay";
  for (int index = 0; index < (replay ? 1 : count); ++index) {
    auto input = seed;
    if (!replay && index > 0) {
      switch (random32() % 5) {
        case 0:
          input.resize(random32() % (input.size() + 1)); break;
        case 1:
        case 2: {
          const auto edits = 1 + random32() % 8;
          for (unsigned edit = 0; edit < edits && !input.empty(); ++edit) {
            const auto at = random32() % input.size();
            input[at] ^= static_cast<uint8_t>(1 + random32() % 255);
          }
          break;
        }
        case 3:
          if (!input.empty()) input.insert(input.begin() + random32() % input.size(), 0);
          break;
        case 4:
          if (target == "rtsp") {
            const std::string duplicate = "RTSP/1.0 200 OK\r\nCSeq: 1\r\nCSeq: 2\r\n\r\n";
            input.assign(duplicate.begin(), duplicate.end());
          } else if (!input.empty()) input.back() = static_cast<uint8_t>(random32());
          break;
      }
    }
    assert(input.size() <= 4096);
    // Keep just the current synthetic case so a crash can be replayed exactly.
    std::ofstream file(argv[5], std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char*>(input.data()), input.size());
    file.close();
    std::printf("case=%d bytes=%zu\n", index, input.size());
    std::fflush(stdout);
    check(target, input);
    if (__lsan_do_recoverable_leak_check()) return 2;
  }
  return 0;
}
