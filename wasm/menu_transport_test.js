'use strict';
// Production scheduler/resolver with real threads and controlled blocking jobs.
// No PC, TV, DNS traffic, private certificate or widget build.
const fs=require('fs'),cp=require('child_process'),path=require('path'),assert=require('assert');
const scope=require('./menu-transport-scope.cjs');
for(const file of ['wasm/http.cpp','wasm/main.cpp','wasm/moonlight_wasm.hpp','libgamestream/http.c','libgamestream/http.h','wasm/platform/messages.js']) {
 const current=fs.readFileSync(file,'utf8'),old=cp.execFileSync('git',['show','7cc3eba:'+file],{encoding:'utf8'});
 assert.strictEqual(scope.normalize(file,current),old,file+' approved integration only');
 assert.notStrictEqual(scope.normalize(file,current+'\n// unexpected'),old,file+' unknown edit rejected');
}
scope.assertIntroduced('wasm/menu_http.hpp',fs.readFileSync('wasm/menu_http.hpp','utf8'));
assert.throws(()=>scope.assertIntroduced('wasm/menu_http.hpp',fs.readFileSync('wasm/menu_http.hpp','utf8')+'\n// unexpected'));
const temporary=fs.mkdtempSync(path.join(require('os').tmpdir(),'moonlight-menu-transport-'));
const source=String.raw`
#include "menu_http.hpp"
#include <cassert>
#include <future>
#include <iostream>
#include <atomic>
using namespace std::chrono_literals;
struct Gate {
 std::promise<void> entered, release;
 std::shared_future<void> ready=release.get_future().share();
 void hold(){entered.set_value();assert(ready.wait_for(4s)==std::future_status::ready);}
 void wait(){assert(entered.get_future().wait_for(2s)==std::future_status::ready);}
};
struct Reply {
 std::promise<mlhttp::Result> result;
 std::future<mlhttp::Result> future=result.get_future();
 std::atomic<int> calls{0};
 auto callback(){return [this](mlhttp::Result r){assert(++calls==1);result.set_value(std::move(r));};}
 bool get(bool expected){assert(future.wait_for(2s)==std::future_status::ready);assert(future.get().ok==expected);return true;}
};
mlhttp::Result ok(const mlhttp::Request& r){assert(r.active());return {true,"fixture",{}};}
int main(){
 {
  mlhttp::Transport t;Gate art;Reply a,m;
  t.submit(1,true,2000,[&](const auto& r){art.hold();return ok(r);},a.callback());art.wait();
  t.submit(2,false,500,ok,m.callback());m.get(true);assert(a.calls==0);
  art.release.set_value();a.get(true);t.stop();t.stop();
 }
 {
  mlhttp::Transport t;Gate work;Reply active,queued,expired,reused;
  std::atomic<int> runs{0};
  t.submit(10,false,2000,[&](const auto&){work.hold();return mlhttp::Result{true,"late",{}};},active.callback());work.wait();
  t.submit(11,false,1000,[&](const auto&r){runs++;return ok(r);},queued.callback());
  t.cancel(11);queued.get(false);
  t.submit(12,false,30,[&](const auto&r){runs++;return ok(r);},expired.callback());expired.get(false);
  t.cancel(10);active.get(false);
  // Reusing an ID cannot let the old worker retire/publish the new reply.
  t.submit(10,false,2000,ok,reused.callback());
  work.release.set_value();reused.get(true);assert(runs==0);
  t.cancel(999);t.stop();assert(active.calls==1&&queued.calls==1&&expired.calls==1&&reused.calls==1);
 }
 {
  mlhttp::Transport t;Gate work;Reply active,overflow;
  std::atomic<int> retired{0};
  t.submit(100,false,2000,[&](const auto&){work.hold();return mlhttp::Result{};},active.callback());work.wait();
  for(int i=0;i<31;i++)t.submit(101+i,false,2000,ok,[&](auto r){assert(!r.ok);retired++;});
  t.submit(200,false,2000,ok,overflow.callback());overflow.get(false);
  for(int i=0;i<31;i++)t.cancel(101+i);assert(retired==31);
  t.cancel(100);active.get(false);work.release.set_value();t.stop();
 }
 {
  mlhttp::Transport t;Gate work;Reply expired,healthy;
  t.submit(300,false,30,[&](const auto&){work.hold();return mlhttp::Result{true,"stale",{}};},expired.callback());work.wait();
  expired.get(false);
  t.submit(301,true,500,ok,healthy.callback());healthy.get(true);
  work.release.set_value();t.stop();assert(expired.calls==1);
 }
 {
  // A pending native DNS call is bounded to one worker. Cancellation wakes
  // callers, releases their ownership and does not require that call to end.
  Gate dns;std::atomic<int> lookups{0};std::promise<void> lookupFinished;
  auto resolver=std::make_unique<mlhttp::Resolver>([&](const auto&){lookups++;dns.hold();lookupFinished.set_value();return std::vector<mlhttp::Address>{{"192.0.2.1",0}};});
  mlhttp::Request request{1,0,mlhttp::Clock::now()+2s};
  auto first=std::async(std::launch::async,[&]{return resolver->resolve("fixture.invalid",request);});dns.wait();
  __atomic_store_n(&request.cancelled,1,__ATOMIC_RELAXED);resolver->notify();
  assert(first.wait_for(300ms)==std::future_status::ready&&first.get().empty());
  for(int i=0;i<20;i++){
   mlhttp::Request next{2+i,0,mlhttp::Clock::now()+1ms};
   assert(resolver->resolve("fixture.invalid",next).empty());
  }
  assert(lookups==1);
  auto begin=mlhttp::Clock::now();resolver.reset();assert(mlhttp::Clock::now()-begin<300ms);
  dns.release.set_value();
  // Wait until the lookup stops accessing the platform fixture's state.
  assert(lookupFinished.get_future().wait_for(2s)==std::future_status::ready);
 }
 for(int i=0;i<50;i++){
  mlhttp::Transport t;Reply reply;
  t.submit(i,false,1000,ok,reply.callback());reply.get(true);t.stop();
 }
 std::cout<<"menu_transport_test: isolated lanes, independent deadlines/cancellation, one-shot replies, ID reuse, bounded queue/DNS and 50 teardown cycles passed\n";
}
`;
fs.writeFileSync(path.join(temporary,'test.cpp'),source);
const sanitizer=process.env.ML_MENU_HTTP_SANITIZER||'address,undefined';
assert(['address,undefined','thread'].includes(sanitizer));
cp.execFileSync('g++',['-std=c++17','-O1','-g','-fno-omit-frame-pointer','-fsanitize='+sanitizer,
 '-pthread','-Iwasm',path.join(temporary,'test.cpp'),'-o',path.join(temporary,'test')],{stdio:'inherit',timeout:60000});
cp.execFileSync(path.join(temporary,'test'),[],{stdio:'inherit',timeout:30000,
 env:{...process.env,ASAN_OPTIONS:'detect_leaks=1',UBSAN_OPTIONS:'halt_on_error=1'}});
console.log('menu_transport_test: production transport/resolver contracts passed');
