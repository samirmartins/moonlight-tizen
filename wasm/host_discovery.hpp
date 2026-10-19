#pragma once

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <functional>
#include <string>
#include <vector>
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace mlrediscovery {
using Clock = std::chrono::steady_clock;
constexpr size_t MaxCandidates = 8;
constexpr size_t MaxProbes = 32;
constexpr size_t MaxSockets = 2;

inline bool ParseIp(const std::string& text, uint32_t& value) {
  in_addr address{};
  if (inet_pton(AF_INET, text.c_str(), &address) != 1) return false;
  value = ntohl(address.s_addr);
  return true;
}
inline std::string FormatIp(uint32_t value) {
  in_addr address{htonl(value)}; char text[INET_ADDRSTRLEN]{};
  return inet_ntop(AF_INET, &address, text, sizeof(text)) ? text : "";
}
struct Network {
  uint32_t own = 0, mask = 0, first = 0, count = 0;
  bool parse(const std::string& ip, const std::string& subnet) {
    if (!ParseIp(ip, own) || !ParseIp(subnet, mask)) return false;
    const uint32_t inverse = ~mask;
    if (!mask || inverse < 3 || (inverse & (inverse + 1)) ||
        (own >> 24) == 0 || (own >> 24) == 127 || own >= 0xe0000000u) return false;
    first = (own & mask) + 1; count = inverse - 1;
    return contains(own);
  }
  bool contains(uint32_t value) const {
    return count && value >= first && static_cast<uint64_t>(value) < static_cast<uint64_t>(first) + count &&
      (value >> 24) != 0 && (value >> 24) != 127 && value < 0xe0000000u;
  }
  std::vector<uint32_t> window(uint32_t preferred, uint32_t cursor, uint32_t& next, size_t limit = MaxProbes) const {
    std::vector<uint32_t> out;
    if (!count) { next = 0; return out; }
    const uint32_t start = contains(preferred) ? (preferred - first + 1) % count : 0;
    uint32_t visited = 0;
    while (visited < std::min<uint32_t>(count, MaxProbes + 1) && out.size() < std::min(limit, MaxProbes)) {
      const uint32_t value = first + static_cast<uint32_t>((static_cast<uint64_t>(start) + cursor + visited) % count);
      ++visited;
      if (value != own && contains(value)) out.push_back(value);
    }
    next = static_cast<uint32_t>((static_cast<uint64_t>(cursor) + visited) % count);
    return out;
  }
};

// DNS compression is untrusted input. Bound packet size, labels, jumps and
// record counts; advertisements provide hints, never host authentication.
inline uint16_t U16(const uint8_t* p) { return static_cast<uint16_t>((p[0] << 8) | p[1]); }
inline bool Name(const uint8_t* data, size_t size, size_t& offset, std::string& out) {
  size_t pos = offset, after = 0, jumps = 0;
  out.clear();
  for (size_t labels = 0; labels < 128; ++labels) {
    if (pos >= size) return false;
    const uint8_t n = data[pos++];
    if (!n) { offset = after ? after : pos; return out.size() <= 253; }
    if ((n & 0xc0) == 0xc0) {
      if (pos >= size || ++jumps > 16) return false;
      if (!after) after = pos + 1;
      pos = ((n & 0x3f) << 8) | data[pos];
      continue;
    }
    if ((n & 0xc0) || pos + n > size || out.size() + n + 1 > 253) return false;
    if (!out.empty()) out += '.';
    for (size_t i = 0; i < n; ++i) {
      uint8_t c = data[pos++];
      if (c < 32 || c == 127) return false;
      out += static_cast<char>(c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c);
    }
  }
  return false;
}
inline bool Instance(const std::string& name) {
  const std::string suffix = "._nvstream._tcp.local";
  return name.size() > suffix.size() && name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0;
}
inline std::vector<uint8_t> Query(uint16_t id) {
  std::vector<uint8_t> packet(12, 0); packet[0] = id >> 8; packet[1] = id & 255; packet[5] = 1;
  for (const auto& label : {std::string("_nvstream"), std::string("_tcp"), std::string("local")}) {
    packet.push_back(static_cast<uint8_t>(label.size())); packet.insert(packet.end(), label.begin(), label.end());
  }
  packet.insert(packet.end(), {0, 0, 12, 0, 1}); // PTR/IN; ephemeral port requests a legacy unicast response.
  return packet;
}
inline std::vector<uint32_t> Answers(const uint8_t* data, size_t size, uint16_t id, uint32_t sender, const Network& network) {
  if (!network.contains(sender) || sender == network.own || size < 12 || size > 2048 || U16(data) != id ||
      !(data[2] & 0x80) || (data[2] & 0x7a) || (data[3] & 15)) return {};
  const size_t questions = U16(data + 4), records = static_cast<size_t>(U16(data + 6)) + U16(data + 8) + U16(data + 10);
  if (questions > 8 || records > 64) return {};
  size_t pos = 12; std::string name;
  for (size_t i = 0; i < questions; ++i) {
    if (!Name(data, size, pos, name) || pos + 4 > size) return {};
    pos += 4;
  }
  bool service = false;
  std::vector<std::string> targets;
  std::vector<std::pair<std::string, uint32_t>> addresses;
  for (size_t i = 0; i < records; ++i) {
    if (!Name(data, size, pos, name) || pos + 10 > size) return {};
    const uint16_t type = U16(data + pos), klass = U16(data + pos + 2) & 0x7fff, bytes = U16(data + pos + 8);
    const bool live = data[pos + 4] || data[pos + 5] || data[pos + 6] || data[pos + 7];
    pos += 10;
    if (pos + bytes > size) return {};
    const size_t end = pos + bytes;
    if (klass == 1 && live) {
      if (type == 12 && name == "_nvstream._tcp.local") {
        size_t at = pos; std::string instance;
        if (!Name(data, size, at, instance) || at != end) return {};
        service |= Instance(instance);
      } else if (type == 33 && Instance(name) && bytes >= 7 && U16(data + pos + 4)) {
        size_t at = pos + 6; std::string target;
        if (!Name(data, size, at, target) || at != end) return {};
        service = true; targets.push_back(target);
      } else if (type == 1 && bytes == 4) {
        const uint32_t ip = (static_cast<uint32_t>(data[pos]) << 24) | (static_cast<uint32_t>(data[pos + 1]) << 16) |
          (static_cast<uint32_t>(data[pos + 2]) << 8) | data[pos + 3];
        addresses.emplace_back(name, ip);
      }
    }
    pos = end;
  }
  std::vector<uint32_t> out;
  if (!service) return out;
  auto add = [&](uint32_t ip) {
    if (out.size() < MaxCandidates && network.contains(ip) && ip != network.own &&
        std::find(out.begin(), out.end(), ip) == out.end()) out.push_back(ip);
  };
  for (const auto& a : addresses) if (std::find(targets.begin(), targets.end(), a.first) != targets.end()) add(a.second);
  add(sender);
  return out;
}

struct Socket {
  int fd = -1;
  explicit Socket(int value = -1) : fd(value) {}
  ~Socket() { if (fd >= 0) close(fd); }
  Socket(const Socket&) = delete;
  Socket& operator=(const Socket&) = delete;
};
inline bool Nonblocking(int fd) {
  const int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}
struct Result { std::vector<uint32_t> addresses; uint32_t next = 0; };
inline Result Discover(const Network& network, uint32_t preferred, uint16_t port, uint32_t cursor,
                       uint16_t queryId, const std::function<bool()>& active,
                       const std::string& multicast = "224.0.0.251", uint16_t mdnsPort = 5353) {
  Result result; result.next = cursor;
  if (!network.count || !port || !active()) return result;
  const auto end = Clock::now() + std::chrono::milliseconds(1800);
  auto add = [&](uint32_t ip) {
    if (result.addresses.size() < MaxCandidates && std::find(result.addresses.begin(), result.addresses.end(), ip) == result.addresses.end()) result.addresses.push_back(ip);
  };
  {
    Socket udp(socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP));
    sockaddr_in local{}; local.sin_family = AF_INET; local.sin_addr.s_addr = htonl(network.own);
    sockaddr_in group{}; group.sin_family = AF_INET; group.sin_port = htons(mdnsPort);
    const unsigned char ttl = 255;
    if (udp.fd >= 0 && Nonblocking(udp.fd) && bind(udp.fd, reinterpret_cast<sockaddr*>(&local), sizeof(local)) == 0 &&
        inet_pton(AF_INET, multicast.c_str(), &group.sin_addr) == 1) {
      setsockopt(udp.fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl));
      setsockopt(udp.fd, IPPROTO_IP, IP_MULTICAST_IF, &local.sin_addr, sizeof(local.sin_addr));
      const auto packet = Query(queryId);
      const auto until = std::min(end, Clock::now() + std::chrono::milliseconds(600));
      size_t datagrams = 0;
      for (int round = 0; round < 2 && active() && Clock::now() < until && result.addresses.empty(); ++round) {
        sendto(udp.fd, packet.data(), packet.size(), MSG_DONTWAIT, reinterpret_cast<sockaddr*>(&group), sizeof(group));
        const auto receiveUntil = std::min(until, Clock::now() + std::chrono::milliseconds(300));
        while (active() && Clock::now() < receiveUntil && datagrams < 64 && result.addresses.size() < MaxCandidates) {
          pollfd p{udp.fd, POLLIN, 0};
          if (poll(&p, 1, 20) <= 0 || !(p.revents & POLLIN)) continue;
          uint8_t data[2048]; sockaddr_in source{}; socklen_t size = sizeof(source);
          const ssize_t n = recvfrom(udp.fd, data, sizeof(data), MSG_DONTWAIT, reinterpret_cast<sockaddr*>(&source), &size);
          if (n <= 0) continue;
          ++datagrams;
          if (source.sin_family != AF_INET || source.sin_port != htons(mdnsPort)) continue;
          for (uint32_t ip : Answers(data, static_cast<size_t>(n), queryId, ntohl(source.sin_addr.s_addr), network)) {
            if (result.addresses.size() < MaxCandidates / 2) add(ip);
          }
        }
      }
    }
  }
  // Another PC's advertisement must not suppress the bounded fallback. Neither
  // advertisements nor open ports authenticate a host; TLS/UUID follows later.
  if (!active()) return result;
  uint32_t next = cursor;
  const auto window = network.window(preferred, cursor, next);
  struct Probe { int fd = -1; uint32_t ip = 0; Clock::time_point deadline; };
  std::array<Probe, MaxSockets> probes{};
  size_t attempted = 0;
  while (active() && Clock::now() < end && result.addresses.size() < MaxCandidates) {
    for (auto& probe : probes) {
      if (probe.fd >= 0 || attempted >= window.size()) continue;
      const uint32_t ip = window[attempted++];
      const int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
      if (fd < 0) continue;
      if (!Nonblocking(fd)) { close(fd); continue; }
      sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(port); address.sin_addr.s_addr = htonl(ip);
      const int status = connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address));
      if (status == 0) { add(ip); close(fd); continue; }
      if (errno != EINPROGRESS && errno != EWOULDBLOCK) { close(fd); continue; }
      probe = {fd, ip, Clock::now() + std::chrono::milliseconds(100)};
    }
    std::array<pollfd, MaxSockets> events{}; bool pending = false;
    for (size_t i = 0; i < probes.size(); ++i) {
      events[i] = {probes[i].fd, POLLOUT, 0}; pending |= probes[i].fd >= 0;
    }
    if (!pending && attempted >= window.size()) break;
    if (pending) poll(events.data(), events.size(), 20);
    for (size_t i = 0; i < probes.size(); ++i) {
      auto& probe = probes[i];
      if (probe.fd < 0) continue;
      if (events[i].revents || Clock::now() >= probe.deadline) {
        int error = 0; socklen_t size = sizeof(error);
        if ((events[i].revents & POLLOUT) && getsockopt(probe.fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 && !error) add(probe.ip);
        close(probe.fd); probe.fd = -1;
      }
    }
  }
  for (auto& probe : probes) if (probe.fd >= 0) close(probe.fd);
  // Advance only the window actually attempted, even if the total time expired.
  result.next = next;
  if (attempted < window.size()) network.window(preferred, cursor, result.next, attempted);
  return result;
}
inline std::string Json(const Result& result) {
  std::string text = "{\"cursor\":" + std::to_string(result.next) + ",\"addresses\":[";
  for (uint32_t ip : result.addresses) { if (text.back() != '[') text += ','; text += '"' + FormatIp(ip) + '"'; }
  return text + "]}";
}
} // namespace mlrediscovery
