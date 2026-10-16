'use strict';
// Compile the production lifecycle with real pthreads and a controllable EMSS.
// It verifies ownership/failure ordering, not physical Samsung playback.
const fs=require('fs'), cp=require('child_process'), path=require('path'), assert=require('assert');
const source=fs.readFileSync('wasm/main.cpp','utf8');
const begin=source.indexOf('void MoonlightInstance::OnConnectionStopped(');
const end=source.indexOf('void* MoonlightInstance::InputThreadFunc(',begin);
assert(begin>0&&end>begin);
const cycles=Number(process.env.ML_LIFECYCLE_CYCLES||30);
assert(Number.isInteger(cycles)&&cycles>0&&cycles<=10000);
const sanitizer=process.env.ML_LIFECYCLE_SANITIZER||'address,undefined';
assert(['address,undefined','thread'].includes(sanitizer));
const fixture=`
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <memory>
#include <functional>
#include <string>
#include <thread>
#include <chrono>
#include <cassert>
#include <iostream>
#include <pthread.h>
#include "session_lifecycle.hpp"
#include <cerrno>
static std::atomic<bool> failCreate{false};
static int recordingCreate(pthread_t* thread,const pthread_attr_t* attr,
                           void*(*entry)(void*),void* context) {
 if(failCreate.exchange(false))return EAGAIN;
 return pthread_create(thread,attr,entry,context);
}
#define pthread_create recordingCreate
namespace samsung { namespace wasm {
 enum class OperationResult{kSuccess,kFailed};
 struct ElementaryMediaTrack { void SetListener(void*) {} };
}}
enum class EmssReadyState{kDetached,kClosed,kOpen};
static std::atomic<unsigned> stops{0},closes{0},destroyed{0},messages{0};
void LiSendKeyboardEvent(int,int,int){}
void LiStopConnection(){stops++;}
void NotifyInputEvent(){}
void PostToJs(std::string){messages++;}
#define KEY_ACTION_UP 4
#define MAIN_THREAD_ASYNC_EM_ASM(...) ((void)0)
#define MSG_STREAM_TERMINATED "streamTerminated: "
struct Result {bool ok; explicit operator bool()const{return ok;}};
struct Source {
 EmssReadyState state=EmssReadyState::kOpen;
 struct StateResult {
  EmssReadyState state; bool ok; explicit operator bool()const{return ok;}
  EmssReadyState operator*()const{return state;}
 };
 StateResult GetReadyState(){return {state,mode!=4};}
 int mode=0; std::thread deferred;
 std::function<void(samsung::wasm::OperationResult)> pending;
 ~Source(){if(deferred.joinable())deferred.join();destroyed++;}
 void SetListener(void*){}
 Result Close(std::function<void(samsung::wasm::OperationResult)> cb) {
  closes++;
  if(mode==2){pending=cb;return {true};}
  if(mode==3)return {false};
  if(mode==5){cb(samsung::wasm::OperationResult::kFailed);return {true};}
  if(mode==1)deferred=std::thread([cb]{std::this_thread::sleep_for(std::chrono::milliseconds(1));cb(samsung::wasm::OperationResult::kSuccess);});
  else cb(samsung::wasm::OperationResult::kSuccess);
  return {true};
 }
};
class MoonlightInstance {
 public:
 struct SessionJob {MoonlightInstance* instance;uint32_t generation;};
 std::atomic<bool> m_Running{false},m_ConnectionCancelled{false},m_StopNeedsLiStop{false},m_VideoStarted{false};
 pthread_t m_ConnectionThread=0,m_InputThread=0,m_StopThread=0;
 std::mutex m_Mutex,m_LifecycleMutex;
 std::condition_variable m_EmssStateChanged,m_EmssVideoStateChanged;
 std::unique_ptr<Source> m_Source;
 std::unique_ptr<int> m_SourceListener,m_VideoTrackListener;
 std::atomic<uint32_t> m_SessionGeneration{0};
 std::atomic<bool> m_StopComplete{true};
 mlsession::Phase m_SessionPhase{mlsession::Phase::Idle};
 std::shared_ptr<mlsession::CloseTicket> m_CloseTicket;
 std::shared_ptr<mlsession::CloseTicket> m_OpenTicket;
 EmssReadyState m_EmssReadyState=EmssReadyState::kDetached;
 samsung::wasm::ElementaryMediaTrack m_VideoTrack;int m_VideoSessionId=0;
 void UnlockMouse(){}
 bool IsCurrentSession(uint32_t g)const{return g==m_SessionGeneration.load();}
 void OnConnectionStarted(uint32_t);void OnConnectionStopped(uint32_t);void StopConnection();void RequestStop(uint32_t,bool);
 void ReleaseMedia();bool BeginSession();static void* StopThreadFunc(void*);
 void Open(int mode=0){
  assert(BeginSession());m_Source=std::make_unique<Source>();m_Source->mode=mode;
  m_EmssReadyState=EmssReadyState::kOpen;m_VideoStarted=true;m_VideoSessionId=99;
  m_Running=true;m_SessionPhase=mlsession::Phase::Running;
 }
 void WaitStop(){
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(6);
  while(!m_StopComplete.load()) {
   assert(std::chrono::steady_clock::now()<deadline);
   std::this_thread::yield();
  }
  if(m_StopThread){pthread_join(m_StopThread,nullptr);m_StopThread=0;}
 }
};
`;
const tests=`
int main(){
 for(int i=0;i<${cycles};i++){
  MoonlightInstance app;app.Open(i%2);
  pthread_create(&app.m_ConnectionThread,nullptr,[](void*)->void*{return nullptr;},nullptr);
  pthread_create(&app.m_InputThread,nullptr,[](void* p)->void*{
   auto* app=static_cast<MoonlightInstance*>(p);while(app->m_Running)std::this_thread::yield();return nullptr;
  },&app);
  const auto before=stops.load(),beforeClose=closes.load();
  std::thread a([&]{app.StopConnection();}),b([&]{app.StopConnection();});
  a.join();b.join();app.WaitStop();
  assert(stops==before+1&&closes==beforeClose+1&&!app.m_Source);
  assert(!app.m_ConnectionThread&&!app.m_InputThread&&!app.m_VideoStarted);
  const auto oldGeneration=app.m_SessionGeneration.load();
  app.Open();
  auto* old=new MoonlightInstance::SessionJob{&app,oldGeneration};
  MoonlightInstance::StopThreadFunc(old);
  assert(app.m_Source&&app.m_Running&&app.m_VideoSessionId==99);
  app.StopConnection();app.WaitStop();
 }
 { // Missing callback: bounded worker, no premature release or restart.
  MoonlightInstance app;app.Open(2);auto* retained=app.m_Source.get();
  app.StopConnection();assert(!app.BeginSession());app.WaitStop();
  assert(app.m_Source.get()==retained&&!app.BeginSession());
  const auto previous=app.m_SessionGeneration.load();
  const auto late=retained->pending;
  late(samsung::wasm::OperationResult::kSuccess);
  assert(app.BeginSession()&&!app.m_Source&&app.m_SessionGeneration==previous+1);
  app.m_Source=std::make_unique<Source>();app.m_Running=true;app.m_VideoSessionId=88;
  late(samsung::wasm::OperationResult::kFailed);
  assert(app.m_Source&&app.m_Running&&app.m_VideoSessionId==88);
  app.m_EmssReadyState=EmssReadyState::kOpen;
  app.StopConnection();app.WaitStop();
 }
 { // Open callback absent: retain the source even if cached state says Closed.
  MoonlightInstance app;app.Open();app.m_EmssReadyState=EmssReadyState::kClosed;
  app.m_OpenTicket=std::make_shared<mlsession::CloseTicket>();
  auto pending=app.m_OpenTicket;auto* retained=app.m_Source.get();
  app.StopConnection();app.WaitStop();
  assert(!app.BeginSession()&&app.m_Source.get()==retained);
  pending->Complete(true);
  assert(!app.BeginSession()&&app.m_Source.get()==retained);
 }
 { // Failed Close: retain source; a subsequent stream may not overwrite it.
  MoonlightInstance app;app.Open(3);auto* retained=app.m_Source.get();
  app.StopConnection();app.WaitStop();assert(!app.BeginSession()&&app.m_Source.get()==retained);
 }
 { // Startup failure does not call LiStop twice; Closed needs no close.
  MoonlightInstance app;app.Open();app.m_EmssReadyState=EmssReadyState::kClosed;app.m_Source->state=EmssReadyState::kClosed;
  const auto before=stops.load(),beforeClose=closes.load();
  app.OnConnectionStopped(1);app.OnConnectionStopped(1);app.WaitStop();
  assert(stops==before&&closes==beforeClose&&!app.m_Source);
 }
 for(int mode:{4,5}) {
  MoonlightInstance app;app.Open(mode);auto* retained=app.m_Source.get();
  app.StopConnection();app.WaitStop();assert(!app.BeginSession()&&app.m_Source.get()==retained);
 }
 {
  MoonlightInstance app;app.Open();failCreate=true;app.StopConnection();
  assert(!app.m_StopThread&&!app.m_StopComplete&&!app.BeginSession()&&app.m_Source);
  const auto before=messages.load();app.OnConnectionStarted(0);assert(messages==before);
 }
 return 0;
}
`;
const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'moonlight-lifecycle-test-'));
try{
 const file=path.join(tmp,'test.cpp'),bin=path.join(tmp,'test');
 const connected=source.slice(source.indexOf('void MoonlightInstance::OnConnectionStarted('),begin);
 fs.writeFileSync(file,fixture+connected+source.slice(begin,end)+tests);
 cp.execFileSync('g++',['-std=c++17','-O1','-g','-pthread','-fsanitize='+sanitizer,'-fno-omit-frame-pointer','-Iwasm',file,'-o',bin],{stdio:'inherit'});
 cp.execFileSync(bin,[],{stdio:'inherit',timeout:Math.max(15000,cycles*30)});
 console.log('session_lifecycle_test: real concurrent duplicate stops, bounded missing/failed close, retained ownership, late callback, stale worker and repeated reopen OK');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
