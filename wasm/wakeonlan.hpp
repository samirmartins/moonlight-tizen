#pragma once
#include <array>
#include <cstring>
#include <string>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>

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
inline std::string Send(const std::string& mac) {
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
  address.sin_port = htons(9);
  address.sin_addr.s_addr = INADDR_BROADCAST;
  bool sent = false;
  // Finite burst, no resident worker/timer or unscoped IPv6 multicast.
  for (int i = 0; i < 3; ++i) {
    sent |= sendto(fd, packet.data(), packet.size(), MSG_DONTWAIT,
                   reinterpret_cast<sockaddr*>(&address), sizeof(address)) ==
            static_cast<ssize_t>(packet.size());
  }
  close(fd);
  return sent ? "" : "TV could not send the local Wake-on-LAN broadcast.";
}
}
