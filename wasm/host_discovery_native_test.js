'use strict';
// Production parser and socket coordinator with deterministic syscall adapters.
// Never opens a real socket or probes the developer's LAN.
const fs=require('fs'),cp=require('child_process'),path=require('path'),os=require('os'),assert=require('assert');
const scope=require('./rediscovery-scope.cjs');
scope.assertIntroduced('wasm/host_discovery.hpp',fs.readFileSync('wasm/host_discovery.hpp','utf8'));
assert.throws(()=>scope.assertIntroduced('wasm/host_discovery.hpp',fs.readFileSync('wasm/host_discovery.hpp','utf8')+'\n// unknown'));
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'moonlight-host-discovery-'));
const source=String.raw`
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
#include <cassert>
#include <iostream>
#include <map>
#include <set>
#include <thread>
namespace fixture {
struct Descriptor{bool udp;uint32_t ip=0;};
std::map<int,Descriptor> descriptors;
std::vector<uint32_t> attempted;std::set<uint32_t> accepting;
std::vector<uint8_t> response;int serial=10,maxTcp=0,queries=0,received=0;bool udp=false;
int socket(int,int type,int){if(type==SOCK_DGRAM&&!udp)return -1;int fd=serial++;descriptors.emplace(fd,Descriptor{type==SOCK_DGRAM,0});return fd;}
int close(int fd){assert(descriptors.erase(fd)==1);return 0;}
int fcntl(int fd,int,...){assert(descriptors.count(fd));return 0;}
int bind(int fd,const sockaddr*,socklen_t){assert(descriptors.count(fd));return 0;}
int setsockopt(int fd,int,int,const void*,socklen_t){assert(descriptors.count(fd));return 0;}
int connect(int fd,const sockaddr* target,socklen_t){
 auto ip=ntohl(reinterpret_cast<const sockaddr_in*>(target)->sin_addr.s_addr);
 descriptors.at(fd).ip=ip;attempted.push_back(ip);
 int count=0;for(const auto& d:descriptors)count+=!d.second.udp;maxTcp=std::max(count,maxTcp);assert(maxTcp<=2);
 errno=EINPROGRESS;return -1;
}
int poll(pollfd* fds,nfds_t count,int){
 int ready=0;
 for(size_t i=0;i<count;i++){
  fds[i].revents=0;if(fds[i].fd<0)continue;
  auto d=descriptors.at(fds[i].fd);
  if(d.udp){if(!response.empty()&&!received){fds[i].revents=POLLIN;ready++;}}
  else{fds[i].revents=POLLOUT;ready++;}
 }
 if(!ready)std::this_thread::sleep_for(std::chrono::milliseconds(1));return ready;
}
int getsockopt(int fd,int,int,void* value,socklen_t*){*static_cast<int*>(value)=accepting.count(descriptors.at(fd).ip)?0:ECONNREFUSED;return 0;}
ssize_t sendto(int fd,const void*,size_t bytes,int,const sockaddr* group,socklen_t){assert(descriptors.at(fd).udp);
 assert(ntohl(reinterpret_cast<const sockaddr_in*>(group)->sin_addr.s_addr)==0xe00000fbu);queries++;return bytes;}
ssize_t recvfrom(int fd,void* data,size_t bytes,int,sockaddr* source,socklen_t*){
 assert(descriptors.at(fd).udp&&!received++);assert(response.size()<=bytes);memcpy(data,response.data(),response.size());
 auto* a=reinterpret_cast<sockaddr_in*>(source);a->sin_family=AF_INET;a->sin_port=htons(5353);inet_pton(AF_INET,"192.0.2.20",&a->sin_addr);return response.size();
}
void reset(){assert(descriptors.empty());attempted.clear();accepting.clear();response.clear();queries=received=maxTcp=0;udp=false;}
}
#define socket fixture::socket
#define close fixture::close
#define fcntl fixture::fcntl
#define bind fixture::bind
#define setsockopt fixture::setsockopt
#define connect fixture::connect
#define poll fixture::poll
#define getsockopt fixture::getsockopt
#define sendto fixture::sendto
#define recvfrom fixture::recvfrom
#include "host_discovery.hpp"
#undef socket
#undef close
#undef fcntl
#undef bind
#undef setsockopt
#undef connect
#undef poll
#undef getsockopt
#undef sendto
#undef recvfrom
using namespace mlrediscovery;
uint32_t ip(const std::string& text){uint32_t value=0;assert(ParseIp(text,value));return value;}
void name(std::vector<uint8_t>& p,std::string value){size_t at=0;while(at<value.size()){size_t end=value.find('.',at);if(end==std::string::npos)end=value.size();p.push_back(end-at);p.insert(p.end(),value.begin()+at,value.begin()+end);at=end+1;}p.push_back(0);}
std::vector<uint8_t> answer(){
 std::vector<uint8_t> p(12,0);p[0]=0x12;p[1]=0x34;p[2]=0x84;p[7]=2;
 name(p,"fixture._nvstream._tcp.local");p.insert(p.end(),{0,33,0,1,0,0,0,120,0,0});size_t length=p.size()-2,begin=p.size();
 p.insert(p.end(),{0,0,0,0,0xbb,0x75});name(p,"fixture.local");p[length]=0;p[length+1]=p.size()-begin;
 name(p,"fixture.local");p.insert(p.end(),{0,1,0,1,0,0,0,120,0,4,192,0,2,20});return p;
}
int main(){
 Network n;assert(n.parse("192.0.2.12","255.255.255.128"));
 assert(n.count==126&&!n.contains(ip("192.0.2.0"))&&!n.contains(ip("192.0.2.127"))&&!n.contains(ip("192.0.2.200")));
 uint32_t next=0;auto w=n.window(ip("192.0.2.10"),0,next);assert(w.size()==32&&next==33&&w.front()==ip("192.0.2.11"));
 assert(std::find(w.begin(),w.end(),n.own)==w.end());
 uint32_t partial=0;n.window(ip("192.0.2.10"),0,partial,2);assert(partial==3);
 Network larger;assert(larger.parse("192.0.2.12","255.255.254.0")&&larger.count==510);
 std::set<uint32_t> visited;uint32_t cursor=0;
 for(int i=0;i<16;i++){auto window=larger.window(0,cursor,next);visited.insert(window.begin(),window.end());cursor=next;}
 assert(visited.size()==509&&visited.count(larger.first+509));
 for(const auto& mask:{"0.0.0.0","255.0.255.0","255.255.255.254","invalid"}){Network bad;assert(!bad.parse("192.0.2.12",mask));}
 for(const auto& address:{"127.0.0.1","224.0.0.251","192.0.2.0","192.0.2.127","invalid"}){Network bad;assert(!bad.parse(address,"255.255.255.128"));}
 auto packet=answer();auto hints=Answers(packet.data(),packet.size(),0x1234,ip("192.0.2.20"),n);assert(hints==std::vector<uint32_t>{ip("192.0.2.20")});
 assert(Answers(packet.data(),packet.size(),0x1235,ip("192.0.2.20"),n).empty());
 assert(Answers(packet.data(),packet.size(),0x1234,ip("192.0.2.200"),n).empty());
 assert(Answers(packet.data(),packet.size(),0x1234,n.own,n).empty());
 for(size_t length=0;length<packet.size();length++)assert(Answers(packet.data(),length,0x1234,ip("192.0.2.20"),n).empty());
 auto broken=packet;broken[12]=0xc0;broken[13]=12;assert(Answers(broken.data(),broken.size(),0x1234,ip("192.0.2.20"),n).empty());
 broken=packet;broken[2]|=2;assert(Answers(broken.data(),broken.size(),0x1234,ip("192.0.2.20"),n).empty());
 // Deterministic malformed compression/length/record fuzz under ASan/UBSan.
 uint32_t seed=0x54671234;for(int i=0;i<10000;i++){
  auto fuzz=packet;seed=seed*1664525u+1013904223u;size_t index=seed%fuzz.size();fuzz[index]^=seed>>24;
  Answers(fuzz.data(),fuzz.size(),0x1234,ip("192.0.2.20"),n);
 }
 auto q=Query(0x1234);assert(U16(q.data())==0x1234&&U16(q.data()+4)==1&&q.size()<64);
 fixture::reset();fixture::accepting.insert(ip("192.0.2.20"));
 auto found=Discover(n,ip("192.0.2.10"),47984,0,0x1234,[]{return true;});
 assert(found.addresses==std::vector<uint32_t>{ip("192.0.2.20")}&&found.next==33);
 assert(fixture::attempted.size()==32&&fixture::maxTcp<=2&&fixture::descriptors.empty());
 assert(Json(found).find("192.0.2.20")!=std::string::npos);
 fixture::reset();fixture::udp=true;fixture::response=packet;
 found=Discover(n,0,47984,0,0x1234,[]{return true;});
 assert(std::find(found.addresses.begin(),found.addresses.end(),ip("192.0.2.20"))!=found.addresses.end());
 assert(fixture::queries==1&&fixture::attempted.size()==32&&fixture::descriptors.empty());
 fixture::reset();int checks=0;
 found=Discover(n,0,47984,0,1,[&]{return ++checks<3;});assert(fixture::attempted.size()<=2&&fixture::descriptors.empty());
 fixture::reset();found=Discover(n,0,47984,0,1,[]{return false;});assert(fixture::attempted.empty());
 std::cout<<"host_discovery_native_test: bounded DNS parser/fuzz, actual CIDR windows, socket budget, cancellation, hint-only discovery and cleanup passed\n";
}
`;
fs.writeFileSync(path.join(directory,'test.cpp'),source);
cp.execFileSync('g++',['-std=c++17','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-pthread','-Iwasm',path.join(directory,'test.cpp'),'-o',path.join(directory,'test')],{stdio:'inherit',timeout:60000});
cp.execFileSync(path.join(directory,'test'),[],{stdio:'inherit',timeout:10000,env:{...process.env,ASAN_OPTIONS:'detect_leaks=1',UBSAN_OPTIONS:'halt_on_error=1'}});
console.log('host_discovery_native_test: native parser and bounded socket coordinator passed');
