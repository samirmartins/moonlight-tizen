#include "moonlight_wasm.hpp"

#include <cmath>

#include <Limelight.h>

#define KEY_PREFIX 0x80

static int ConvertButtonToLiButton(unsigned short button) {
  switch (button) {
    case 0:
      return BUTTON_LEFT;
    case 1:
      return BUTTON_MIDDLE;
    case 2:
      return BUTTON_RIGHT;
    default:
      return 0;
  }
}

static char GetModifierFlags(const EmscriptenKeyboardEvent &event) {
  char flags = 0;

  if (event.ctrlKey == true) {
    flags |= MODIFIER_CTRL;
  }
  if (event.altKey == true) {
    flags |= MODIFIER_ALT;
  }
  if (event.shiftKey == true) {
    flags |= MODIFIER_SHIFT;
  }

  return flags;
}

EM_BOOL MoonlightInstance::HandleMouseDown(const EmscriptenMouseEvent &event) {
  if (!m_MouseLocked) {
    LockMouse();
    m_MouseLastPosX = event.screenX;
    m_MouseLastPosY = event.screenY;
    return EM_TRUE;
  }

  LiSendMouseButtonEvent(BUTTON_ACTION_PRESS, ConvertButtonToLiButton(event.button));
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleMouseMove(const EmscriptenMouseEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  m_MouseDeltaX.fetch_add(event.movementX, std::memory_order_relaxed);
  m_MouseDeltaY.fetch_add(event.movementY, std::memory_order_relaxed);
  NotifyInputEvent();

  m_MouseLastPosX = event.screenX;
  m_MouseLastPosY = event.screenY;

  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleMouseUp(const EmscriptenMouseEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, ConvertButtonToLiButton(event.button));
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleWheel(const EmscriptenWheelEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  // Inverted delta y-axis to restore correct wheel direction
  // Preserve fractional wheel deltas without sharing a non-atomic float with
  // the input worker. Values are stored as milli-ticks until they are sent.
  m_AccumulatedTicks.fetch_add(
    static_cast<int32_t>(std::lround(-event.deltaY * 1000.0)),
    std::memory_order_relaxed);
  NotifyInputEvent();
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleKeyDown(const EmscriptenKeyboardEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  char modifiers = GetModifierFlags(event);
  uint32_t keyCode = event.keyCode;

  // Check if the current modifier flags match the defined key combination on the keyboard
  if (modifiers == (MODIFIER_CTRL | MODIFIER_ALT | MODIFIER_SHIFT)) {
    if (keyCode == 0x51) { // Q key
      // Terminate the connection
      stopStream();
      return EM_TRUE;
    } else if (keyCode == 0x53) { // S key
      // Toggle performance stats overlay
      toggleStats();
      return EM_TRUE;
    } else {
      // Wait until these keys come up to unlock the mouse
      m_WaitingForAllModifiersUp = true;
    }
  }

  LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, KEY_ACTION_DOWN, modifiers);
  return EM_TRUE;
}

EM_BOOL MoonlightInstance::HandleKeyUp(const EmscriptenKeyboardEvent &event) {
  if (!m_MouseLocked) {
    return EM_FALSE;
  }

  char modifiers = GetModifierFlags(event);
  uint32_t keyCode = event.keyCode;

  // Check if all modifiers are up now
  if (m_WaitingForAllModifiersUp && modifiers == 0) {
    UnlockMouse();
    m_WaitingForAllModifiersUp = false;
  }

  LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, KEY_ACTION_UP, modifiers);
  return EM_TRUE;
}

EM_BOOL handleKeyDown(int eventType, const EmscriptenKeyboardEvent *event, void *userData) {
  return g_Instance->HandleKeyDown(*event);
}

EM_BOOL handleKeyUp(int eventType, const EmscriptenKeyboardEvent *event, void *userData) {
  return g_Instance->HandleKeyUp(*event);
}

EM_BOOL handleMouseMove(int eventType, const EmscriptenMouseEvent *event, void *userData) {
  return g_Instance->HandleMouseMove(*event);
}

EM_BOOL handleMouseUp(int eventType, const EmscriptenMouseEvent *event, void *userData) {
  return g_Instance->HandleMouseUp(*event);
}

EM_BOOL handleMouseDown(int eventType, const EmscriptenMouseEvent *event, void *userData) {
  return g_Instance->HandleMouseDown(*event);
}

EM_BOOL handleWheel(int eventType, const EmscriptenWheelEvent *event, void *userData) {
  return g_Instance->HandleWheel(*event);
}

EM_BOOL handlePointerLockChange(int eventType, const EmscriptenPointerlockChangeEvent *pointerlockChangeEvent, void *userData) {
  if (!pointerlockChangeEvent) {
    return false;
  }

  if (pointerlockChangeEvent->isActive) {
    g_Instance->DidLockMouse(0);
  } else {
    g_Instance->MouseLockLost();
  }

  return true;
}

EM_BOOL handlePointerLockError(int eventType, const void *reserved, void *userData) {
  g_Instance->DidLockMouse(eventType);
  return true;
}

void MoonlightInstance::ReportMouseMovement() {
  const int32_t deltaX = m_MouseDeltaX.exchange(0, std::memory_order_acq_rel);
  const int32_t deltaY = m_MouseDeltaY.exchange(0, std::memory_order_acq_rel);
  if (deltaX != 0 || deltaY != 0) {
    LiSendMouseMoveEvent(deltaX, deltaY);
  }

  const int32_t accumulatedTicks =
    m_AccumulatedTicks.exchange(0, std::memory_order_acq_rel);
  if (accumulatedTicks != 0) {
    // We can have fractional ticks here, so multiply by WHEEL_DELTA
    // to get actual scroll distance and use the high-res variant.
    LiSendHighResScrollEvent(static_cast<short>(std::lround(
      accumulatedTicks * 5.0 / 1000.0)));
  }
}

void MoonlightInstance::LockMouse() {
  emscripten_request_pointerlock(kCanvasName, false);
}

void MoonlightInstance::UnlockMouse() {
  emscripten_exit_pointerlock();
}

void MoonlightInstance::DidLockMouse(int32_t result) {
  if (result != 0) {
    ClLogMessage("Error locking mouse, event type: %d\n", result);
  }

  m_MouseLocked = (result == 0);
  if (m_MouseLocked) {
    // Request an IDR frame to dump the frame queue that may have
    // built up from the GL pipeline being stalled.
    LiRequestIdrFrame();
  }
}

void MoonlightInstance::MouseLockLost() {
  m_MouseLocked = false;
}

void sendKeyboardEvent(uint32_t keyCode, uint16_t action, char modifiers) {
  // Send a keyboard event to the host
  LiSendKeyboardEvent(KEY_PREFIX << 8 | keyCode, action, modifiers);
}

EMSCRIPTEN_BINDINGS(input) {
  emscripten::function("sendKeyboardEvent", &sendKeyboardEvent);
}
