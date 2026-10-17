'use strict';
// Compile production collection, aggregation and both formatters against a
// deterministic clock/transport adapter; no Samsung decoder is substituted.
const assert=require('assert'),fs=require('fs'),cp=require('child_process'),path=require('path');
const file='wasm/wasmplayer.cpp',current=fs.readFileSync(file,'utf8');
const baseline=cp.execFileSync('git',['show','v3.4.3:'+file],{encoding:'utf8'});
const normalize=require('./overlay-aggregation-scope.cjs').normalize;
assert.strictEqual(normalize(file,current),baseline,'only the approved aggregation move');
for(const [before,after] of [
  ['kStatsUpdateMs < statsNowMs','kStatsUpdateMs <= statsNowMs'],
  ['PublishDiagnostics(m_ActiveWndVideoStats','PublishDiagnostics(m_LastWndVideoStats'],
  ['AddVideoStats(m_LastWndVideoStats, lastTwoWndStats);','AddVideoStats(m_ActiveWndVideoStats, lastTwoWndStats);'],
  ['memcpy(&m_LastWndVideoStats','memset(&m_LastWndVideoStats']]) {
  assert(current.includes(before));assert.notStrictEqual(normalize(file,current.replace(before,after)),baseline,'reject neighboring mutation '+before);
}
function between(source,start,end) {
  const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,start);return source.slice(a,b);
}
const header=fs.readFileSync('wasm/moonlight_wasm.hpp','utf8');
const stats=between(header,'typedef struct _VIDEO_STATS {','enum class LoadResult');
const includes=`
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>
#include "Limelight.h"
#include "video_telemetry.hpp"
#define MIN(a,b) ((a)<(b)?(a):(b))
#define MAX(a,b) ((a)>(b)?(a):(b))
${stats}
`;
const adapter=`
using TimeStamp=std::chrono::duration<double>;
struct DecodeUnit {int frameNumber,fullLength;uint16_t frameHostProcessingLatency;};
uint32_t nowMs=1000,s_Width=2560,s_Height=1440,s_Framerate=60;
int s_VideoFormat=VIDEO_FORMAT_H265,m_LastFrameNumber=0;
uint32_t total_bytes=0;bool s_collectingStats=false,s_hasLastAppendTime=false;
uint32_t clockReads=0,rttReads=0,aggregateCalls=0;
bool rttAvailable=true;
double s_leadFilteredMs=11.25,s_leadTargetMs=11.0;
int s_leadSamples=120;bool s_leadTargetSet=true;
constexpr int64_t kNoPipelinePosition=INT64_MIN;
constexpr uint32_t kStatsUpdateMs=2000;
TimeStamp s_ptsStep(1.0/60.0);
VIDEO_STATS m_ActiveWndVideoStats{},m_LastWndVideoStats{};
mltelemetry::HitchTracker s_HitchTracker{};
std::string s_StatString(4096,0),s_PendingStatMsg;
std::vector<std::string> messages;
uint64_t SteadyUs(std::chrono::time_point<std::chrono::steady_clock>){return static_cast<uint64_t>(nowMs)*1000;}
uint32_t LiGetMillis(){clockReads++;return nowMs;}
bool LiGetEstimatedRttInfo(uint32_t* rtt,uint32_t* variance){rttReads++;if(!rttAvailable)return false;*rtt=3;*variance=1;return true;}
bool LiGetCurrentHostDisplayHdrMode(){return false;}
void PostToJsAsync(const std::string& message){messages.push_back(message);}
struct Position {int64_t positionUs;uint32_t atMs;};
struct Clock {Position Read(){return {static_cast<int64_t>(nowMs)*1000-11000,nowMs-3};}};
class MoonlightInstance {
public:
 std::atomic<bool> m_OverlayStatsEnabled{false};std::atomic<uint32_t> m_DiagnosticsGeneration{0};Clock m_PipelinePosition;
 static void AddVideoStats(VIDEO_STATS&,VIDEO_STATS&);
 static void RealAddVideoStats(VIDEO_STATS&,VIDEO_STATS&);
 static void FormatVideoStats(VIDEO_STATS&,char*,int);
 static void PublishDiagnostics(VIDEO_STATS&,uint32_t,uint32_t,uint32_t);
 template<bool CollectStats> static void Submit(DecodeUnit*);
};
MoonlightInstance app;MoonlightInstance* g_Instance=&app;
void MoonlightInstance::AddVideoStats(VIDEO_STATS& source,VIDEO_STATS& destination){aggregateCalls++;RealAddVideoStats(source,destination);}
void Reset(int format,uint32_t fps) {
 nowMs=1000;s_VideoFormat=format;s_Framerate=fps;s_ptsStep=TimeStamp(1.0/fps);
 m_ActiveWndVideoStats={};m_LastWndVideoStats={};s_HitchTracker={};
 s_collectingStats=false;s_hasLastAppendTime=false;m_LastFrameNumber=0;total_bytes=0;
 clockReads=rttReads=aggregateCalls=0;messages.clear();s_PendingStatMsg.clear();std::fill(s_StatString.begin(),s_StatString.end(),0);
}
void Feed(uint32_t frame) {
 auto& s=m_ActiveWndVideoStats;
 s.decodedFrames++;s.renderedFrames++;s.zeroCopyFrames++;
 const uint32_t delta=15000+frame%11*300;
 s.hostIntervalCount++;s.hostIntervalSumMs+=delta/1000.0;s.hostIntervalSumSqMs+=delta/1000.0*(delta/1000.0);
 s.appendIntervalCount++;s.appendIntervalSumMs+=delta/1000.0;s.appendIntervalSumSqMs+=delta/1000.0*(delta/1000.0);
 s.appendLateIntervals+=frame%19==0;s.hostLateIntervals+=frame%17==0;
 s.pipelineClockSamples++;s.pipelineClockLeadSumMs+=11.0;s.pipelineClockLeadSumSqMs+=121.0;s.pipelineClockLeadMaxMs=12;
 mltelemetry::Add(s.hostIntervalsUs,delta);mltelemetry::Add(s.appendIntervalsUs,delta+frame%7*100);
 mltelemetry::Add(s.assemblyUs,100+frame%300);mltelemetry::Add(s.appendUs,200+frame%1000);
 mltelemetry::Add(s.framePackets,60+frame%30);mltelemetry::Add(s.pipelineLeadUs,11000);
 mltelemetry::Observe(s_HitchTracker,frame%37==0,static_cast<uint64_t>(nowMs)*1000);
}
`;
function implementation(name,source) {
  const methodStart=source.indexOf('template<bool CollectStats>\nint MoonlightInstance::VidDecSubmitDecodeUnitImpl');
  assert(methodStart>0);
  const collection=between(source.slice(methodStart),'  if constexpr (CollectStats) {',"  // Derive this frame's timestamp");
  const methods=between(source,'void MoonlightInstance::AddVideoStats(', 'void MoonlightInstance::TogglePerformanceStats(')
    .replace('void MoonlightInstance::AddVideoStats(','void MoonlightInstance::RealAddVideoStats(');
  return 'namespace '+name+' {\n'+adapter+methods+
    '\ntemplate<bool CollectStats> void MoonlightInstance::Submit(DecodeUnit* decodeUnit) {\n'+collection+'}\n'+
    'template<bool CollectStats> void Submit(DecodeUnit* unit){MoonlightInstance::Submit<CollectStats>(unit);}\n}\n';
}
const tests=`
void Compare() {
 assert(std::memcmp(&old::m_ActiveWndVideoStats,&candidate::m_ActiveWndVideoStats,sizeof(VIDEO_STATS))==0);
 assert(std::memcmp(&old::m_LastWndVideoStats,&candidate::m_LastWndVideoStats,sizeof(VIDEO_STATS))==0);
 assert(old::total_bytes==candidate::total_bytes);
 assert(old::messages==candidate::messages);
 assert(old::s_collectingStats==candidate::s_collectingStats);
 assert(old::m_LastFrameNumber==candidate::m_LastFrameNumber);
 assert(old::s_StatString==candidate::s_StatString);
}
void Step(uint32_t frame,uint32_t now,bool overlay,uint32_t generation) {
 old::nowMs=candidate::nowMs=now;
 old::app.m_OverlayStatsEnabled=candidate::app.m_OverlayStatsEnabled=overlay;
 old::app.m_DiagnosticsGeneration=candidate::app.m_DiagnosticsGeneration=generation;
 const int number=static_cast<int>(frame+frame/29);
 old::DecodeUnit a{number,80000+static_cast<int>(frame%50000),static_cast<uint16_t>(frame%4?40+frame%100:0)};
 candidate::DecodeUnit b{a.frameNumber,a.fullLength,a.frameHostProcessingLatency};
 if(overlay||generation) {old::Submit<true>(&a);candidate::Submit<true>(&b);old::Feed(frame);candidate::Feed(frame);}
 else {old::Submit<false>(&a);candidate::Submit<false>(&b);}
 Compare();
}
int main() {
 uint32_t cases=0,frames=0;
 for(const int format:{VIDEO_FORMAT_H264,VIDEO_FORMAT_H265,VIDEO_FORMAT_H265_MAIN10,VIDEO_FORMAT_AV1_MAIN8,VIDEO_FORMAT_AV1_MAIN10})
 for(const uint32_t fps:{30u,60u,120u})for(int mode=0;mode<4;mode++) {
  old::Reset(format,fps);candidate::Reset(format,fps);
  const bool overlay=mode&1;const uint32_t generation=(mode&2)?7:0;
  for(uint32_t i=1;i<=600;i++){Step(i,1000+i*1000/fps,overlay,generation);frames++;}
  if(!overlay&&!generation)assert(old::clockReads==0&&candidate::clockReads==0&&old::rttReads==0&&candidate::rttReads==0&&candidate::messages.empty());
  if(overlay)assert(old::aggregateCalls==candidate::aggregateCalls&&candidate::aggregateCalls>0);
  if(generation&&!overlay) {
   assert(old::aggregateCalls>0&&candidate::aggregateCalls==0);
   assert(old::rttReads==candidate::rttReads+old::aggregateCalls);
   assert(old::clockReads==candidate::clockReads+old::aggregateCalls);
   assert(!candidate::messages.empty());
  }
  cases++;
 }
 // Toggle independently within and across window boundaries, including exact
 // 2000/2001 ms edges, generation changes, empty history and unavailable RTT.
 old::Reset(VIDEO_FORMAT_H265,60);candidate::Reset(VIDEO_FORMAT_H265,60);
 uint32_t rng=12345,now=1000;
 for(uint32_t i=1;i<=12000;i++) {
  rng=rng*1664525+1013904223;now+=rng%7==0?2000:17;
  const bool overlay=(i/53)%3==1;const uint32_t generation=(i/97)%3==1?0:1+i/500;
  old::rttAvailable=candidate::rttAvailable=(i/73)%2;
  Step(i,now,overlay,generation);frames++;
 }
 old::Reset(VIDEO_FORMAT_H264,60);candidate::Reset(VIDEO_FORMAT_H264,60);
 Step(1,1000,false,1);Step(2,3000,false,1);assert(candidate::messages.empty());
 Step(3,3001,false,1);assert(candidate::messages.size()==1);
 assert(old::aggregateCalls==2&&candidate::aggregateCalls==0);
 // The previous diagnostic-only window remains available when the overlay is
 // enabled later: its first combined display is byte-identical to baseline.
 Step(4,5002,true,1);assert(candidate::messages.size()==3);
 assert(candidate::messages[1].find("StatMsg: ")==0&&candidate::messages[2].find("DiagMsg: ")==0);
 std::cout<<"overlay_aggregation_test: "<<cases<<" codec/rate/consumer cases, "<<frames
  <<" frames and independent toggles; identical messages/history; hidden overlay skips two aggregations and two RTT/clock queries per window; VIDEO_STATS="<<sizeof(VIDEO_STATS)<<" bytes\\n";
}
`;
const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'moonlight-overlay-test-'));
try {
  const file=path.join(tmp,'test.cpp'),bin=path.join(tmp,'test');
  fs.writeFileSync(file,includes+implementation('old',baseline)+implementation('candidate',current)+tests);
  cp.execFileSync('g++',['-std=c++17','-O1','-g','-pthread','-fsanitize=address,undefined','-fno-omit-frame-pointer','-Iwasm','-Imoonlight-common-c/src',file,'-o',bin],{stdio:'inherit',timeout:30000});
  cp.execFileSync(bin,[],{stdio:'inherit',timeout:30000});
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log('overlay_aggregation_test: production native comparison and exact scope checks passed');
