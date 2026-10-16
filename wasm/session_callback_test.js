'use strict';
const fs=require('fs'),cp=require('child_process'),path=require('path'),assert=require('assert');
const source=fs.readFileSync('wasm/wasmplayer.cpp','utf8');
function method(marker){
 const a=source.indexOf(marker);assert(a>=0,marker);
 let b=source.indexOf('{',a)+1,depth=1;
 while(depth){const c=source[b++];if(c==='{')depth++;else if(c==='}')depth--;assert(b<=source.length);}
 return source.slice(a,b);
}
const fixture=`
#include <atomic>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <cstdint>
#include <cassert>
#include <string>
namespace samsung{namespace wasm {
 using Seconds=std::chrono::duration<double>;
 using SessionId=unsigned;
 enum class MediaPipelineError{kFailed};
 struct ElementaryMediaTrack{enum class CloseReason{kClosed};};
}}
enum class EmssReadyState{kDetached,kClosed,kOpenPending,kOpen};
int logs=0,messages=0,idrs=0;bool s_loggedPipelineClock=false;
void ClLogMessage(const char*,...){logs++;}
void PostToJs(std::string){messages++;}
void LiRequestIdrFrame(){idrs++;}unsigned LiGetMillis(){return 1;}
#define MAIN_THREAD_ASYNC_EM_ASM(...) ((void)0)
struct Clock{int calls=0;bool Store(int64_t,unsigned){calls++;return true;}};
class MoonlightInstance{
public:
 using EmssTrackCloseReason=samsung::wasm::ElementaryMediaTrack::CloseReason;
 std::mutex m_Mutex;std::condition_variable m_EmssStateChanged,m_EmssVideoStateChanged;
 std::atomic<uint32_t> m_SessionGeneration{1};
 std::atomic<bool> m_DecoderActive{true},m_ConnectionCancelled{false},m_DecoderPipelineFailed{false},m_VideoStarted{false};
 std::atomic<unsigned> m_VideoSessionId{0};Clock m_PipelinePosition;
 EmssReadyState m_EmssReadyState=EmssReadyState::kDetached;int stops=0;
 bool IsCurrentSession(uint32_t g)const{return g==m_SessionGeneration.load();}
 void StopConnection(){stops++;m_ConnectionCancelled=true;}
 class SourceListener{
 public:
  MoonlightInstance* m_Instance;const uint32_t m_Generation;
  SourceListener(MoonlightInstance*,uint32_t);
  void OnSourceOpen();void OnSourceOpenPending();void OnSourceClosed();
  void OnPipelineError(samsung::wasm::MediaPipelineError,const char*);
  void OnPlaybackPositionChanged(samsung::wasm::Seconds);
 };
 class VideoTrackListener{
 public:
  MoonlightInstance* m_Instance;const uint32_t m_Generation;
  VideoTrackListener(MoonlightInstance*,uint32_t);
  void OnTrackOpen();void OnTrackClosed(EmssTrackCloseReason);
  void OnSessionIdChanged(samsung::wasm::SessionId);
 };
};
`;
const names=['SourceListener::SourceListener','SourceListener::OnSourceOpen','SourceListener::OnSourceOpenPending',
'SourceListener::OnSourceClosed','SourceListener::OnPipelineError','SourceListener::OnPlaybackPositionChanged',
'VideoTrackListener::VideoTrackListener','VideoTrackListener::OnTrackOpen','VideoTrackListener::OnTrackClosed',
'VideoTrackListener::OnSessionIdChanged'];
const body=names.map(x=>method('MoonlightInstance::'+x+'(').replace(/^MoonlightInstance::/,x.includes('::On')?'void MoonlightInstance::':'MoonlightInstance::')).join('\n');
const tests=`
int main(){
 MoonlightInstance app;
 MoonlightInstance::SourceListener oldSource(&app,1),fresh(&app,2);
 MoonlightInstance::VideoTrackListener oldTrack(&app,1),track(&app,2);
 app.m_SessionGeneration=2;
 oldSource.OnSourceOpen();oldSource.OnSourceOpenPending();oldSource.OnSourceClosed();
 oldSource.OnPipelineError(samsung::wasm::MediaPipelineError::kFailed,nullptr);
 oldSource.OnPlaybackPositionChanged(samsung::wasm::Seconds(1));
 oldTrack.OnTrackOpen();oldTrack.OnTrackClosed(MoonlightInstance::EmssTrackCloseReason::kClosed);
 oldTrack.OnSessionIdChanged(4);
 assert(!logs&&!messages&&!idrs&&!app.stops&&!app.m_PipelinePosition.calls);
 assert(app.m_EmssReadyState==EmssReadyState::kDetached&&!app.m_VideoStarted&&!app.m_VideoSessionId);
 fresh.OnSourceOpenPending();assert(app.m_EmssReadyState==EmssReadyState::kOpenPending);
 fresh.OnSourceOpen();assert(app.m_EmssReadyState==EmssReadyState::kOpen);
 track.OnSessionIdChanged(8);track.OnTrackOpen();
 assert(app.m_VideoSessionId==8&&app.m_VideoStarted&&idrs==1);
 fresh.OnPlaybackPositionChanged(samsung::wasm::Seconds(1));
 assert(app.m_PipelinePosition.calls==1);
 fresh.OnPipelineError(samsung::wasm::MediaPipelineError::kFailed,nullptr);
 assert(app.stops==1&&app.m_DecoderPipelineFailed);
 track.OnTrackClosed(MoonlightInstance::EmssTrackCloseReason::kClosed);
 fresh.OnSourceClosed();assert(!app.m_VideoStarted&&app.m_EmssReadyState==EmssReadyState::kClosed);
}
`;
const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'moonlight-callback-test-'));
try{
 const file=path.join(tmp,'test.cpp'),bin=path.join(tmp,'test');
 fs.writeFileSync(file,fixture+body+tests);
 cp.execFileSync('g++',['-std=c++17','-O1','-g','-pthread','-fsanitize=address,undefined','-fno-omit-frame-pointer',file,'-o',bin],{stdio:'inherit'});
 cp.execFileSync(bin,[],{stdio:'inherit',timeout:5000});
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log('session_callback_test: stale source/track/clock/error callbacks rejected; current callbacks preserved');
