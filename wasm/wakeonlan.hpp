#pragma once
#include <array>
#include <cstring>
#include <string>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <chrono>
#include <thread>

namespace mlwol {
inline int Hex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
inline bool Packet(const std::string& text, std::array<unsigned char, 102>& packet) {
  if (text.size() != 17) return false;
  unsigned char mac[6];
  unsigned any = 0;
  for (int i = 0; i < 6; ++i) {
    const int high = Hex(text[i * 3]), low = Hex(text[i * 3 + 1]);
    if (high < 0 || low < 0 || (i < 5 && text[i * 3 + 2] != ':')) return false;
    mac[i] = static_cast<unsigned char>((high << 4) | low);
    any |= mac[i];
  }
  if (!any || (mac[0] & 1)) return false; // not zero, multicast or broadcast
  packet.fill(0xff);
  for (int i = 0; i < 16; ++i) std::memcpy(packet.data() + 6 + i * 6, mac, 6);
  return true;
}
inline std::string Send(const std::string& mac, const std::string& subnetBroadcast = "") {
  std::array<unsigned char, 102> packet;
  if (!Packet(mac, packet)) return "Invalid physical network adapter MAC address.";
  const int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (fd < 0) return "TV could not open the Wake-on-LAN UDP socket.";
  const int broadcast = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast)) < 0) {
    close(fd);
    return "TV could not enable local network broadcast.";
  }
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = INADDR_BROADCAST;
  in_addr directed{};
  const bool useDirected = !subnetBroadcast.empty() &&
    inet_pton(AF_INET, subnetBroadcast.c_str(), &directed) == 1 &&
    directed.s_addr != INADDR_ANY && directed.s_addr != INADDR_BROADCAST;
  bool sent = false;
  // Finite, spaced burst over the common ports and actual TV subnet broadcast.
  for (int i = 0; i < 3; ++i) {
    for (int target = 0; target < (useDirected ? 2 : 1); ++target) {
      address.sin_addr.s_addr = target ? directed.s_addr : INADDR_BROADCAST;
      for (int port : {9, 7}) {
        address.sin_port = htons(port);
        sent |= sendto(fd, packet.data(), packet.size(), MSG_DONTWAIT,
                      reinterpret_cast<sockaddr*>(&address), sizeof(address)) ==
                static_cast<ssize_t>(packet.size());
      }
    }
    if (i < 2) std::this_thread::sleep_for(std::chrono::milliseconds(75));
  }
  close(fd);
  return sent ? "" : "TV could not send the local Wake-on-LAN broadcast.";
}
}
