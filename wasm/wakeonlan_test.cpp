#include <array>
#include <cstring>
#include <string>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <cassert>
#include <iostream>
static int socketResult = 7, optionResult = 0, sendResult = 102;
static int opens = 0, closes = 0, sends = 0;
static int FakeSocket(int domain, int type, int protocol) {
  assert(domain == AF_INET && type == SOCK_DGRAM && protocol == IPPROTO_UDP);
  ++opens; return socketResult;
}
static int FakeOption(int, int level, int option, const void*, socklen_t) {
  assert(level == SOL_SOCKET && option == SO_BROADCAST); return optionResult;
}
static ssize_t FakeSend(int, const void* packet, size_t size, int flags,
                        const sockaddr* address, socklen_t) {
  ++sends;
  assert(size == 102 && (flags & MSG_DONTWAIT));
  const auto* dest = reinterpret_cast<const sockaddr_in*>(address);
  assert(dest->sin_port == htons(9) && dest->sin_addr.s_addr == INADDR_BROADCAST);
  assert(static_cast<const unsigned char*>(packet)[0] == 0xff);
  return sendResult;
}
static int FakeClose(int) { ++closes; return 0; }
#define socket FakeSocket
#define setsockopt FakeOption
#define sendto FakeSend
#define close FakeClose
#include "wakeonlan.hpp"
#undef socket
#undef setsockopt
#undef sendto
#undef close
int main() {
  std::array<unsigned char, 102> packet{};
  const unsigned char mac[] = {0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc};
  assert(mlwol::Packet("12:34:56:78:9a:BC", packet));
  for (int i = 0; i < 6; ++i) assert(packet[i] == 0xff);
  for (int i = 0; i < 16; ++i) assert(std::memcmp(packet.data() + 6 + i * 6, mac, 6) == 0);
  for (const auto* bad : {"", "00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF",
       "01:00:00:00:00:01", "12:34:56:78:9A:BCjunk", "1:2:3:4:5:6", "12-34-56-78-9A-BC",
       "XX:34:56:78:9A:BC"}) assert(!mlwol::Packet(bad, packet));
  assert(!mlwol::Send("invalid").empty() && opens == 0);
  socketResult = -1;
  assert(!mlwol::Send("12:34:56:78:9A:BC").empty() && closes == 0);
  socketResult = 7; optionResult = -1;
  assert(!mlwol::Send("12:34:56:78:9A:BC").empty() && closes == 1 && sends == 0);
  optionResult = 0; sendResult = -1;
  assert(!mlwol::Send("12:34:56:78:9A:BC").empty() && closes == 2 && sends == 3);
  sendResult = 102;
  assert(mlwol::Send("12:34:56:78:9A:BC").empty() && closes == 3 && sends == 6);
  std::cout << "wakeonlan_test: ok (mock sockets, no PC woken)\n";
}
