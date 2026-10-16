'use strict';
// Compile the production setup method with a recording Samsung API adapter.
const fs=require('fs'),cp=require('child_process'),path=require('path'),assert=require('assert');
const source=fs.readFileSync('wasm/wasmplayer.cpp','utf8');
const begin=source.indexOf('int MoonlightInstance::StartupVidDecSetup('),end=source.indexOf('int MoonlightInstance::VidDecSetup(',begin);
assert(begin>=0&&end>begin);
const fixture=`
#include <string>
#include <vector>
#include <optional>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <cassert>
#include "Limelight.h"
namespace samsung { namespace wasm {
 enum class OperationResult { kSuccess };
 enum class DecodingMode { kHardware };
 struct ElementaryVideoTrackConfig {std::string mime;std::vector<unsigned char> extra;DecodingMode mode;uint32_t width,height,num,den;};
 struct ElementaryVideoTrack {void SetListener(void*){}};
}}
using EmssOperationResult=samsung::wasm::OperationResult;
enum class EmssReadyState {kClosed,kOpenPending,kOpen};
struct Source {
 int rejects=0;std::vector<samsung::wasm::ElementaryVideoTrackConfig> attempts;
 std::optional<samsung::wasm::ElementaryVideoTrack> AddTrack(samsung::wasm::ElementaryVideoTrackConfig c) {
  attempts.push_back(c);if(rejects-->0)return {};return samsung::wasm::ElementaryVideoTrack{};
 }
 bool Open(std::function<void(EmssOperationResult)> cb){cb(EmssOperationResult::kSuccess);return true;}
};
struct Element {void SetSrc(Source*){};void Play(std::function<void(EmssOperationResult)> cb){cb(EmssOperationResult::kSuccess);}};
class MoonlightInstance {
public:
 std::shared_ptr<Source> m_Source=std::make_shared<Source>();
 Element m_MediaElement;std::atomic<bool> m_ConnectionCancelled{false},m_VideoStarted{true};
 EmssReadyState m_EmssReadyState=EmssReadyState::kClosed;
 std::condition_variable m_EmssStateChanged,m_EmssVideoStateChanged;
 std::shared_ptr<mlsession::CloseTicket> m_OpenTicket;
 samsung::wasm::ElementaryVideoTrack m_VideoTrack;std::unique_ptr<int> m_VideoTrackListener;bool waitResult=true;
 bool WaitFor(std::condition_variable*,std::function<bool()>){return waitResult;}
 int StartupVidDecSetup(int,int,int,int,void*,int);
};
MoonlightInstance* g_Instance;
void ClLogMessage(const char*,...){}
`;
const tests=`
int main(){
 for(int format : {VIDEO_FORMAT_H264,VIDEO_FORMAT_H265,VIDEO_FORMAT_H265_MAIN10,VIDEO_FORMAT_AV1_MAIN8,VIDEO_FORMAT_AV1_MAIN10})
 for(int width : {1920,2560,3840}) for(int fps : {30,60,120}) {
  MoonlightInstance app;g_Instance=&app;const int height=width==1920?1080:width==2560?1440:2160;
  assert(app.StartupVidDecSetup(format,width,height,fps,nullptr,0)==0);
  auto cfg=app.m_Source->attempts.front();assert(cfg.width==width&&cfg.height==height&&cfg.num==fps&&cfg.den==1);
  assert(cfg.mode==samsung::wasm::DecodingMode::kHardware&&cfg.extra.empty());
  if(format==VIDEO_FORMAT_H264)assert(cfg.mime.find(width==2560&&fps<=60?"avc1.640033":"avc1.64002A")!=std::string::npos);
  if(format==VIDEO_FORMAT_H265||format==VIDEO_FORMAT_H265_MAIN10){
   assert(cfg.mime.find(format==VIDEO_FORMAT_H265?"hev1.1.6.":"hev1.2.4.")!=std::string::npos);
   assert(cfg.mime.find(width==1920?"H123":"L153")!=std::string::npos);
  }
  if(format==VIDEO_FORMAT_AV1_MAIN8)assert(cfg.mime.find("av01.0.13M.08")!=std::string::npos);
  if(format==VIDEO_FORMAT_AV1_MAIN10)assert(cfg.mime.find("av01.0.13M.10")!=std::string::npos);
 }
 MoonlightInstance app;g_Instance=&app;app.m_Source->rejects=1;
 assert(app.StartupVidDecSetup(VIDEO_FORMAT_H265,1920,1080,60,nullptr,0)==0);
 assert(app.m_Source->attempts.size()==2&&app.m_Source->attempts.back().mime.find("L123")!=std::string::npos);
 app.m_Source->rejects=100;
 assert(app.StartupVidDecSetup(VIDEO_FORMAT_H265,1920,1080,60,nullptr,0)==-1);
 assert(app.StartupVidDecSetup(0,1920,1080,60,nullptr,0)==-1);
 app.m_ConnectionCancelled=true;assert(app.StartupVidDecSetup(VIDEO_FORMAT_AV1_MAIN8,1920,1080,60,nullptr,0)==-1);
 app.m_ConnectionCancelled=false;app.waitResult=false;
 assert(app.StartupVidDecSetup(VIDEO_FORMAT_AV1_MAIN10,1920,1080,60,nullptr,0)==-1);
}
`;
const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'moonlight-codec-test-'));
try {
 const file=path.join(tmp,'test.cpp'),bin=path.join(tmp,'test');
 fs.writeFileSync(file,'#include <memory>\n#include "session_lifecycle.hpp"\n'+fixture+source.slice(begin,end)+tests);
 cp.execFileSync('g++',['-std=c++17','-O1','-g','-pthread','-fsanitize=address,undefined','-fno-omit-frame-pointer','-Iwasm','-Imoonlight-common-c/src',file,'-o',bin],{stdio:'inherit'});
 cp.execFileSync(bin,[],{stdio:'inherit',timeout:5000});
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log('codec_configuration_test: real H264/HEVC/AV1 setup matrix, HDR profiles, dimensions/FPS, fallback, rejection and cancellation OK');
