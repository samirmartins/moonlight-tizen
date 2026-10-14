'use strict';
// Real stop methods and StartStream's join/reset prologue, with a recording
// pthread scheduler and EMSS adapter. This does not emulate the entire TV.
const fs=require('fs'),cp=require('child_process'),path=require('path'),assert=require('assert');
const source=fs.readFileSync('wasm/main.cpp','utf8');
function section(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert(start>=0&&end>start);return source.slice(start,end);}
const stopped=section('void MoonlightInstance::OnConnectionStopped(', 'void* MoonlightInstance::InputThreadFunc(');
const start=source.indexOf('  if (m_StopThread != 0) {',source.indexOf('MessageResult MoonlightInstance::StartStream('));
const end=source.indexOf('\n  PostToJs(',start);
assert(start>0&&end>start);
const fixture=`
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <memory>
#include <functional>
#include <map>
#include <string>
#include <thread>
#include <chrono>
#include <cassert>
#include <iostream>
#include <pthread.h>
namespace samsung { namespace wasm {
 enum class OperationResult{kSuccess};
 struct ElementaryMediaTrack{};
}}
enum class EmssReadyState{kDetached,kClosed,kOpen};
using Job=void*(*)(void*);
static std::map<pthread_t,Job> jobs;static unsigned created=0,stops=0,closes=0,joins=0;
static int fakeCreate(pthread_t* id,const pthread_attr_t*,Job job,void*){*id=++created;jobs[*id]=job;return 0;}
static int fakeJoin(pthread_t id,void**){auto found=jobs.find(id);assert(found!=jobs.end());auto job=found->second;jobs.erase(found);joins++;job(nullptr);return 0;}
void LiSendKeyboardEvent(int,int,int){}
void LiStopConnection(){stops++;}
void NotifyInputEvent(){}
void PostToJs(std::string){}
#define KEY_ACTION_UP 4
#define MAIN_THREAD_ASYNC_EM_ASM(...) ((void)0)
#define MSG_STREAM_TERMINATED "streamTerminated: "
struct Source {
 int mode=0;std::thread deferred;
 ~Source(){if(deferred.joinable())deferred.join();}
 void Close(std::function<void(samsung::wasm::OperationResult)> cb){
  closes++;if(mode==2)return;
  if(mode==1)deferred=std::thread([cb]{std::this_thread::sleep_for(std::chrono::milliseconds(40));cb(samsung::wasm::OperationResult::kSuccess);});
  else cb(samsung::wasm::OperationResult::kSuccess);
 }
};
class MoonlightInstance {
public:
 std::atomic<bool> m_Running{true},m_ConnectionCancelled{false},m_StopNeedsLiStop{false},m_SourceClosed{false},m_VideoStarted{true};
 pthread_t m_ConnectionThread=0,m_InputThread=0,m_StopThread=0;
 std::mutex m_Mutex;std::condition_variable m_EmssStateChanged,m_EmssVideoStateChanged,m_SourceClosedCV;
 std::shared_ptr<Source> m_Source=std::make_shared<Source>();
 EmssReadyState m_EmssReadyState=EmssReadyState::kOpen;
 samsung::wasm::ElementaryMediaTrack m_VideoTrack;int m_VideoSessionId=1;
 void UnlockMouse(){}
 void OnConnectionStopped(uint32_t);void StopConnection();static void* StopThreadFunc(void*);
 void BeginAgain();
};
MoonlightInstance* g_Instance;
#define pthread_create fakeCreate
#define pthread_join fakeJoin
`;
const tests=`
int main(int argc,char**argv){
 const std::string mode=argc>1?argv[1]:"normal";
 if(mode=="duplicate"){
  MoonlightInstance app;g_Instance=&app;unsigned before=created;
  app.StopConnection();app.StopConnection();
  if(created-before!=1){std::cout<<"duplicate stop creates "<<created-before<<" workers\\n";return 2;}
  return 0;
 }
 if(mode=="stale-worker"){
  MoonlightInstance app;g_Instance=&app;
  app.StopConnection();const auto orphan=app.m_StopThread;
  app.StopConnection();app.BeginAgain();
  app.m_Source=std::make_shared<Source>();app.m_Running=true;
  app.m_EmssReadyState=EmssReadyState::kOpen;app.m_VideoStarted=true;app.m_VideoSessionId=99;
  // A delayed worker from the prior session must not close the new session.
  fakeJoin(orphan,nullptr);
  if(!app.m_Source||!app.m_Running||app.m_VideoSessionId!=99){std::cout<<"old stop worker modifies the reopened session\\n";return 2;}
  return 0;
 }
 if(mode=="missing"){
  MoonlightInstance app;g_Instance=&app;app.m_Source->mode=2;
  app.StopConnection();app.BeginAgain();return 0;
 }
 for(int iteration=0;iteration<30;iteration++){
  MoonlightInstance app;g_Instance=&app;app.m_Source->mode=iteration%2;
  const auto previous=stops,previousCloses=closes;
  fakeCreate(&app.m_ConnectionThread,nullptr,[](void*)->void*{return nullptr;},nullptr);
  fakeCreate(&app.m_InputThread,nullptr,[](void*)->void*{assert(!g_Instance->m_Running);return nullptr;},nullptr);
  app.StopConnection();assert(app.m_ConnectionCancelled);
  app.BeginAgain();
  assert(!app.m_ConnectionCancelled&&!app.m_SourceClosed&&!app.m_Source);
  assert(!app.m_StopThread&&!app.m_InputThread&&!app.m_ConnectionThread);
  assert(app.m_EmssReadyState==EmssReadyState::kDetached&&!app.m_VideoStarted&&app.m_VideoSessionId==0);
  assert(stops==previous+1&&closes==previousCloses+1&&jobs.empty());
 }
 MoonlightInstance unexpected;g_Instance=&unexpected;const auto previous=stops;
 unexpected.OnConnectionStopped(1);unexpected.OnConnectionStopped(1);
 unexpected.BeginAgain();assert(stops==previous&&jobs.empty());
 MoonlightInstance closed;g_Instance=&closed;closed.m_EmssReadyState=EmssReadyState::kClosed;
 const auto previousCloses=closes;closed.StopConnection();closed.BeginAgain();assert(closes==previousCloses);
}
`;
const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'moonlight-lifecycle-test-'));
try{
 const file=path.join(tmp,'test.cpp'),bin=path.join(tmp,'test');
 fs.writeFileSync(file,fixture+stopped+'\nvoid MoonlightInstance::BeginAgain(){\n'+source.slice(start,end)+'\n}\n'+tests);
 cp.execFileSync('g++',['-std=c++17','-O1','-g','-pthread','-fsanitize=address,undefined','-fno-omit-frame-pointer',file,'-o',bin],{stdio:'inherit'});
 cp.execFileSync(bin,[],{stdio:'inherit',timeout:10000});
 if(process.argv.includes('--strict')){
  let failures=0;
  for(const scenario of ['missing','duplicate','stale-worker']){
   const r=cp.spawnSync(bin,[scenario],{encoding:'utf8',timeout:2000});
   if(r.status!==0||r.error){
    failures++;console.error('LIFECYCLE GAP: '+scenario+': '+(r.error?.code||r.stdout.trim()||r.signal||r.status));
   }
  }
  if(failures)process.exitCode=1;
 }
 console.log('session_lifecycle_test: ordered stop/join, deferred close, repeated sessions, unexpected termination and restart prologue checked');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
