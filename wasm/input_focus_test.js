'use strict';
// Compile the complete production DOM input implementation with browser fixtures.
const fs = require('fs'), cp = require('child_process'), path = require('path'), assert = require('assert');
const source = fs.readFileSync('wasm/input.cpp', 'utf8');
const main = fs.readFileSync('wasm/main.cpp', 'utf8');
assert.match(main, /emscripten_set_blur_callback\(EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, EM_TRUE, handleFocusLost\)/);
assert.match(main, /emscripten_set_visibilitychange_callback\(NULL, EM_TRUE, handleVisibilityChange\)/);
const fixture = `
#include <atomic>
#include <bitset>
#include <vector>
#include <cassert>
#include <cstdint>
#include <cstddef>
#include "Limelight.h"
using EM_BOOL = bool;
#define EM_TRUE true
#define EM_FALSE false
#define EMSCRIPTEN_BINDINGS(name) void bind_##name()
struct EmscriptenMouseEvent { unsigned short button = 0; int screenX = 0, screenY = 0, movementX = 0, movementY = 0; };
struct EmscriptenKeyboardEvent { bool ctrlKey = false, altKey = false, shiftKey = false; uint32_t keyCode = 0; };
struct EmscriptenWheelEvent { double deltaY = 0; };
struct EmscriptenPointerlockChangeEvent { bool isActive; };
struct EmscriptenFocusEvent {};
struct EmscriptenVisibilityChangeEvent { bool hidden; };
struct Event { int type, code, action, modifiers; };
std::vector<Event> events;
extern "C" int LiSendKeyboardEvent(short code, char action, char modifiers) { events.push_back({0, (uint16_t)code, action, modifiers}); return 0; }
extern "C" int LiSendMouseButtonEvent(char action, int code) { events.push_back({1, code, action, 0}); return 0; }
extern "C" int LiSendMouseMoveEvent(short x, short y) { events.push_back({2, x, y, 0}); return 0; }
extern "C" int LiSendHighResScrollEvent(short ticks) { events.push_back({3, ticks, 0, 0}); return 0; }
extern "C" void LiRequestIdrFrame(void) {}
namespace emscripten { template<class T> void function(const char*, T) {} }
static const char* kCanvasName = "fixture";
void emscripten_request_pointerlock(const char*, bool) {}
void emscripten_exit_pointerlock() {}
void NotifyInputEvent() {}
void stopStream() {}
void toggleStats() {}
class MoonlightInstance {
public:
 bool m_MouseLocked = true, m_WaitingForAllModifiersUp = false;
 std::atomic<bool> m_Running{true};
 std::bitset<256> m_HeldKeys;
 std::bitset<8> m_HeldMouseButtons;
 long m_MouseLastPosX = -1, m_MouseLastPosY = -1;
 std::atomic<int32_t> m_MouseDeltaX{0}, m_MouseDeltaY{0}, m_AccumulatedTicks{0};
 EM_BOOL HandleMouseDown(const EmscriptenMouseEvent&);
 EM_BOOL HandleMouseUp(const EmscriptenMouseEvent&);
 EM_BOOL HandleMouseMove(const EmscriptenMouseEvent&);
 EM_BOOL HandleWheel(const EmscriptenWheelEvent&);
 EM_BOOL HandleKeyDown(const EmscriptenKeyboardEvent&);
 EM_BOOL HandleKeyUp(const EmscriptenKeyboardEvent&);
 void SendKeyboardInput(uint32_t, uint16_t, char);
 void ReleaseHeldInput(); void ReportMouseMovement();
 void LockMouse(); void UnlockMouse(); void DidLockMouse(int32_t); void MouseLockLost();
 static void ClLogMessage(const char*, ...) {}
};
MoonlightInstance* g_Instance;
`;
const tests = `
int main() {
 MoonlightInstance app; g_Instance = &app;
 EmscriptenKeyboardEvent key; key.keyCode = 0x41;
 app.HandleKeyDown(key); app.HandleKeyDown(key);
 EmscriptenMouseEvent mouse;
 for (int i = 0; i < 3; ++i) { mouse.button = i; app.HandleMouseDown(mouse); }
 assert(events.size() == 5 && app.m_HeldKeys.count() == 1 && app.m_HeldMouseButtons.count() == 3);
 handleFocusLost(0, nullptr, nullptr);
 assert(events.size() == 9 && app.m_HeldKeys.none() && app.m_HeldMouseButtons.none());
 assert(events[5].type == 0 && events[5].code == 0x8041 && events[5].action == KEY_ACTION_UP && events[5].modifiers == 0);
 for (int i = 6; i < 9; ++i) assert(events[i].type == 1 && events[i].action == BUTTON_ACTION_RELEASE);
 handleFocusLost(0, nullptr, nullptr); assert(events.size() == 9);
 app.HandleKeyDown(key); app.HandleKeyUp(key); auto size = events.size();
 app.ReleaseHeldInput(); assert(events.size() == size);
 app.HandleKeyDown(key);
 EmscriptenVisibilityChangeEvent visible{false}, hidden{true};
 handleVisibilityChange(0, &visible, nullptr); assert(app.m_HeldKeys.any());
 handleVisibilityChange(0, &hidden, nullptr); assert(app.m_HeldKeys.none());
 sendKeyboardEvent(0x801b, KEY_ACTION_DOWN, 0); assert(app.m_HeldKeys.test(0x1b));
 EmscriptenPointerlockChangeEvent lock{false}; handlePointerLockChange(0, &lock, nullptr);
 assert(!app.m_MouseLocked && app.m_HeldKeys.none() && events.back().code == 0x801b);
 size = events.size(); app.HandleKeyDown(key); assert(events.size() == size);
 app.m_MouseLocked = true; app.HandleKeyDown(key); app.m_Running = false;
 size = events.size(); app.ReleaseHeldInput(); assert(events.size() == size && app.m_HeldKeys.none());
 app.m_Running = true; app.HandleKeyDown(key); app.HandleKeyUp(key);
 size = events.size(); app.ReleaseHeldInput(); assert(events.size() == size);
 mouse.button = 7; app.HandleMouseDown(mouse); assert(app.m_HeldMouseButtons.none());
 return 0;
}
`;
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'moonlight-focus-test-'));
try {
 const file = path.join(tmp, 'test.cpp'), bin = path.join(tmp, 'test');
 fs.writeFileSync(file, fixture + source.replace('#include "moonlight_wasm.hpp"', '') + tests);
 cp.execFileSync('g++', ['-std=c++17', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
  '-Imoonlight-common-c/src', file, '-o', bin], {stdio: 'inherit'});
 cp.execFileSync(bin, [], {stdio: 'inherit', env: {...process.env, ASAN_OPTIONS: 'detect_leaks=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
console.log('input_focus_test: production key/mouse tracking, blur, visibility, pointer-lock loss and idempotent release OK');
