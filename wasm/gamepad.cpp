#include "moonlight_wasm.hpp"

#include <iostream>
#include <array>
#include <utility>
#include <sstream>
#include <chrono>
#include <thread>
#include <cmath>
#include <map>

#include <Limelight.h>
#include <emscripten/emscripten.h>

// Bitmask for gamepad combo buttons to stop the streaming session
const short STOP_STREAM_BUTTONS = BACK_FLAG | PLAY_FLAG | LB_FLAG | RB_FLAG;

// Bitmask for gamepad combo buttons to toggle the performance stats overlay
const short PERF_STATS_BUTTONS = BACK_FLAG | LB_FLAG | RB_FLAG | X_FLAG;

// Flag for gamepad to track controller rumble state
bool rumbleFeedbackSwitch = false;

// Flags for gamepad to track mouse emulation state
bool mouseEmulationSwitch = false;
bool mouseEmulationActive = false;

// Flags for gamepad to track face buttons state
bool flipABfaceButtonsSwitch = false;
bool flipXYfaceButtonsSwitch = false;

// For explanation on ordering, see: https://www.w3.org/TR/gamepad/#remapping
// Enumeration for gamepad buttons
enum GamepadButton {
  A, B, X, Y,
  LeftBumper, RightBumper,
  LeftTrigger, RightTrigger,
  Back, Play,
  LeftStick, RightStick,
  Up, Down, Left, Right,
  Special,
  Count,
};

// For explanation on ordering, see: https://www.w3.org/TR/gamepad/#remapping
// Enumeration for gamepad axis
enum GamepadAxis {
  LeftX = 0,
  LeftY = 1,
  RightX = 2,
  RightY = 3,
};

// Gamepad state as the main thread hands it over.
//
// The Emscripten gamepad functions cannot be used from here. All three of them
// (emscripten_sample_gamepad_data, emscripten_get_num_gamepads and
// emscripten_get_gamepad_status) are declared __proxy: 'sync' in the SDK,
// because the Gamepad API only exists on the main thread. Calling them from this
// worker blocks it and queues work on the main thread, and this loop runs every
// 5 ms: with one controller that is six hundred synchronous round trips a
// second, on the same thread that schedules audio and services the media
// pipeline. It was the largest consumer of main thread time in the application.
//
// So the direction is inverted. A requestAnimationFrame loop in
// platform/gamepad.js reads navigator.getGamepads() where it already lives,
// writes the result here, and this side just reads memory. No proxying, and the
// sampling rate becomes the display's, which is the useful rate for input.
//
// Plain arithmetic types only: this is written by JS through the heap views.
static constexpr int kMaxSnapshotPads = 4;

struct GamepadState {
  int32_t connected;
  int32_t numAxes;
  int32_t numButtons;
  // Tizen reports gamepads that are not really there, and those keep a
  // timestamp of zero. JS reduces the timestamp to this flag, which is all the
  // logic below ever needed from it.
  int32_t hasTimestamp;
  float axis[8];
  float analogButton[GamepadButton::Count];
  int32_t digitalButton[GamepadButton::Count];
};

struct GamepadSnapshot {
  int32_t numGamepads;
  GamepadState pads[kMaxSnapshotPads];
};

// Every member is four bytes wide and four byte aligned, so the layout has no
// padding and JS can index it with the HEAP32 and HEAPF32 views directly. The
// assertions exist so that adding a field of another width fails the build here
// rather than silently misaligning the writer on the other side.
static_assert(sizeof(GamepadState) ==
                (4 + 8 + GamepadButton::Count + GamepadButton::Count) * 4,
              "GamepadState has padding; platform/gamepad.js indexes it directly");
static_assert(sizeof(GamepadSnapshot) == 4 + kMaxSnapshotPads * sizeof(GamepadState),
              "GamepadSnapshot has padding; platform/gamepad.js indexes it directly");

static GamepadSnapshot s_gpSnapshot = {};

// Handed to JS once, when the input loop starts.
extern "C" EMSCRIPTEN_KEEPALIVE void* gamepadSnapshotAddress() {
  return &s_gpSnapshot;
}

extern "C" EMSCRIPTEN_KEEPALIVE int gamepadSnapshotMaxPads() {
  return kMaxSnapshotPads;
}

extern "C" EMSCRIPTEN_KEEPALIVE int gamepadSnapshotButtonCount() {
  return GamepadButton::Count;
}

// Exported so the writer does not have to reproduce the arithmetic
extern "C" EMSCRIPTEN_KEEPALIVE int gamepadSnapshotStride() {
  return (int)sizeof(GamepadState);
}

// Function to create a mask for active gamepads
static short GetActiveGamepadMask(int numGamepads) {
  short result = 0;
  
  for (int i = 0; i < numGamepads; ++i) {
    result |= (1 << i);
  }
  
  return result;
}

// Function to map gamepad buttons to flags
static short GetButtonFlags(const GamepadState& gamepad) {
  // Triggers are considered analog buttons in the "Emscripten API", however they need
  // to be passed in separate arguments for "Limelight" (it even lacks flags for them).

  const int* buttonMasks = nullptr;
  int buttonMasksSize = 0;

  // Define button mapping with A/B and X/Y swapped
  static const int buttonMasksABXY[] = {
    B_FLAG, A_FLAG, Y_FLAG, X_FLAG,
    LB_FLAG, RB_FLAG,
    0 /* LT_FLAG */, 0 /* RT_FLAG */,
    BACK_FLAG, PLAY_FLAG,
    LS_CLK_FLAG, RS_CLK_FLAG,
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG,
    SPECIAL_FLAG,
  };
  // Define button mapping with A/B swapped
  static const int buttonMasksAB[] = {
    B_FLAG, A_FLAG, X_FLAG, Y_FLAG,
    LB_FLAG, RB_FLAG,
    0 /* LT_FLAG */, 0 /* RT_FLAG */,
    BACK_FLAG, PLAY_FLAG,
    LS_CLK_FLAG, RS_CLK_FLAG,
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG,
    SPECIAL_FLAG,
  };
  // Define button mapping with X/Y swapped
  static const int buttonMasksXY[] = {
    A_FLAG, B_FLAG, Y_FLAG, X_FLAG,
    LB_FLAG, RB_FLAG,
    0 /* LT_FLAG */, 0 /* RT_FLAG */,
    BACK_FLAG, PLAY_FLAG,
    LS_CLK_FLAG, RS_CLK_FLAG,
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG,
    SPECIAL_FLAG,
  };
  // Define default button mapping
  static const int buttonMasksDefault[] = {
    A_FLAG, B_FLAG, X_FLAG, Y_FLAG,
    LB_FLAG, RB_FLAG,
    0 /* LT_FLAG */, 0 /* RT_FLAG */,
    BACK_FLAG, PLAY_FLAG,
    LS_CLK_FLAG, RS_CLK_FLAG,
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG,
    SPECIAL_FLAG,
  };

  // Check if the A/B or X/Y face buttons switches are checked
  if (flipABfaceButtonsSwitch && flipXYfaceButtonsSwitch) {
    // Swap both A/B and X/Y buttons
    buttonMasks = buttonMasksABXY;
    buttonMasksSize = sizeof(buttonMasksABXY) / sizeof(buttonMasksABXY[0]);
  } else if (flipABfaceButtonsSwitch) { // Check if the A/B face buttons switch is checked
    // Swap A and B buttons
    buttonMasks = buttonMasksAB;
    buttonMasksSize = sizeof(buttonMasksAB) / sizeof(buttonMasksAB[0]);
  } else if (flipXYfaceButtonsSwitch) { // Check if the X/Y face buttons switch is checked
    // Swap X and Y buttons
    buttonMasks = buttonMasksXY;
    buttonMasksSize = sizeof(buttonMasksXY) / sizeof(buttonMasksXY[0]);
  } else {
    // Default buttons layout
    buttonMasks = buttonMasksDefault;
    buttonMasksSize = sizeof(buttonMasksDefault) / sizeof(buttonMasksDefault[0]);
  }

  short result = 0;
  
  for (int i = 0; i < gamepad.numButtons && i < buttonMasksSize; ++i) {
    if (gamepad.digitalButton[i] != 0) {
      result |= buttonMasks[i];
    }
  }

  return result;
}

// Function to handle the gamepad input state
void MoonlightInstance::HandleGamepadInputState(bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons) {
  rumbleFeedbackSwitch = rumbleFeedback;
  mouseEmulationSwitch = mouseEmulation;
  flipABfaceButtonsSwitch = flipABfaceButtons;
  flipXYfaceButtonsSwitch = flipXYfaceButtons;
}

// Function to poll gamepad input
void MoonlightInstance::PollGamepads() {
  // Read the snapshot the main thread publishes. See GamepadSnapshot above for
  // why this is not asking Emscripten directly.
  int numGamepads = s_gpSnapshot.numGamepads;
  if (numGamepads > kMaxSnapshotPads) {
    numGamepads = kMaxSnapshotPads;
  }
  if (numGamepads <= 0) {
    return;
  }

  // Create a mask for active gamepads
  const auto activeGamepadMask = GetActiveGamepadMask(numGamepads);

  // Prevent repeated trigger while the button combo is held down
  static std::map<int, bool> comboTriggered;

  // Track valid gamepads that had a non-zero timestamp at least once
  static bool isRealGamepad[32] = { false };

  // Iterate through connected gamepads and process their input
  for (int gamepadID = 0; gamepadID < numGamepads; ++gamepadID) {
    // See logic in getConnectedGamepadMask() (utils.js)
    // These must stay in sync!
    const GamepadState& gamepad = s_gpSnapshot.pads[gamepadID];

    if (!gamepad.connected) {
      // Not connected
      if (gamepadID < 32) {
        isRealGamepad[gamepadID] = false;
      }
      continue;
    }

    if (gamepadID < 32 && gamepad.hasTimestamp) {
      isRealGamepad[gamepadID] = true;
    }

    if (!gamepad.hasTimestamp && (gamepadID >= 32 || !isRealGamepad[gamepadID])) {
      // On some platforms, Tizen returns "connected" gamepads that really 
      // aren't, so timestamp stays at zero. To work around this, we'll only
      // count gamepads that have a non-zero timestamp in our controller index.
      continue;
    }

    // Process input for active gamepad
    const auto buttonFlags = GetButtonFlags(gamepad);
    const auto leftTrigger = gamepad.analogButton[GamepadButton::LeftTrigger]
      * std::numeric_limits<unsigned char>::max();
    const auto rightTrigger = gamepad.analogButton[GamepadButton::RightTrigger]
      * std::numeric_limits<unsigned char>::max();
    const auto leftStickX = gamepad.axis[GamepadAxis::LeftX]
      * std::numeric_limits<short>::max();
    const auto leftStickY = -gamepad.axis[GamepadAxis::LeftY]
      * std::numeric_limits<short>::max();
    const auto rightStickX = gamepad.axis[GamepadAxis::RightX]
      * std::numeric_limits<short>::max();
    const auto rightStickY = -gamepad.axis[GamepadAxis::RightY]
      * std::numeric_limits<short>::max();

    // Check if the current button flags match the defined button combination on the gamepad
    if (buttonFlags == STOP_STREAM_BUTTONS) {
      // Terminate the connection
      stopStream();
      return;
    } else if (buttonFlags == PERF_STATS_BUTTONS) {
      if (!comboTriggered[gamepadID]) {
        // Toggle performance stats overlay
        toggleStats();
        // Mark combo as triggered until buttons are released
        comboTriggered[gamepadID] = true;
      }
    } else {
      // Reset when buttons are released
      comboTriggered[gamepadID] = false;
    }

    // Check if the mouse emulation switch is checked
    if (mouseEmulationSwitch) {
      static std::map<int, std::chrono::time_point<std::chrono::steady_clock>> activatePressTimes;
      // Toggle mouse emulation on and off based on how long the PLAY/START button is pressed
      if (buttonFlags & PLAY_FLAG) {
        if (activatePressTimes.find(gamepadID) == activatePressTimes.end()) {
          activatePressTimes[gamepadID] = std::chrono::steady_clock::now();
        }
        auto currentTime = std::chrono::steady_clock::now();
        // Calculate the duration in milliseconds since the PLAY/START button was pressed
        auto durationTime = std::chrono::duration_cast<std::chrono::milliseconds>(currentTime - activatePressTimes[gamepadID]).count();
        // If the button has been pressed for at least 1000 milliseconds (1 second)
        if (durationTime >= 1000) {
          // Toggle mouse emulation state
          if (!mouseEmulationActive) {
            // Activate mouse emulation and notify the user
            mouseEmulationActive = true;
            PostToJs(std::string("mouseEmulationOn"));
          } else {
            // Deactivate mouse emulation and notify the user
            mouseEmulationActive = false;
            PostToJs(std::string("mouseEmulationOff"));
          }
          // Reset the PLAY/START press time to the current time after toggling
          activatePressTimes[gamepadID] = std::chrono::steady_clock::now();
        }
      } else {
        // If the PLAY/START button is not pressed, reset PLAY/START press time to the current time
        activatePressTimes[gamepadID] = std::chrono::steady_clock::now();
      }
    } else {
      // Deactivate mouse emulation if the mouse emulation switch is unchecked
      mouseEmulationActive = false;
    }

    // If mouse emulation is active, then send mouse input to the desired handler (acts as a mouse)
    if (mouseEmulationActive) {
      // Left Stick values are mapped to horizontal and vertical mouse movements
      const float baseMouseSpeed = 10.0f;
      const float leftStickMagnitude = std::sqrt(leftStickX * leftStickX + leftStickY * leftStickY) / std::numeric_limits<short>::max();
      const float mouseSpeed = baseMouseSpeed * leftStickMagnitude;
      const float mouseXDelta = static_cast<float>(leftStickX) / std::numeric_limits<short>::max() * mouseSpeed;
      const float mouseYDelta = -static_cast<float>(leftStickY) / std::numeric_limits<short>::max() * mouseSpeed;
      
      // Send a mouse move event with the specified delta values for both horizontal (X-axis) and vertical (Y-axis) coordinates
      LiSendMouseMoveEvent(static_cast<int>(mouseXDelta), static_cast<int>(mouseYDelta));

      // Right Stick values are mapped to horizontal and vertical mouse scrolls
      const float baseScrollSpeed = 1.0f;
      const float rightStickMagnitude = std::sqrt(rightStickX * rightStickX + rightStickY * rightStickY) / std::numeric_limits<short>::max();
      const float scrollSpeed = baseScrollSpeed * rightStickMagnitude;
      const float scrollXDelta = static_cast<float>(rightStickX) / std::numeric_limits<short>::max() * scrollSpeed;
      const float scrollYDelta = static_cast<float>(rightStickY) / std::numeric_limits<short>::max() * scrollSpeed;
      
      // Send mouse scroll events with the specified delta values for both horizontal (X-axis) and vertical (Y-axis) coordinates
      LiSendHScrollEvent(static_cast<int>(scrollXDelta));
      LiSendScrollEvent(static_cast<int>(scrollYDelta));

      // Face Buttons values are mapped to control mouse buttons
      if (buttonFlags & (A_FLAG | LB_FLAG)) {
        // Send a mouse button press event for the left button
        LiSendMouseButtonEvent(BUTTON_ACTION_PRESS, BUTTON_LEFT);
      } else {
        // Send a mouse button release event for the left button
        LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, BUTTON_LEFT);
      }
      if (buttonFlags & (X_FLAG | Y_FLAG)) {
        // Send a mouse button press event for the Middle button
        LiSendMouseButtonEvent(BUTTON_ACTION_PRESS, BUTTON_MIDDLE);
      } else {
        // Send a mouse button release event for the Middle button
        LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, BUTTON_MIDDLE);
      }
      if (buttonFlags & (B_FLAG | RB_FLAG)) {
        // Send a mouse button press event for the Right button
        LiSendMouseButtonEvent(BUTTON_ACTION_PRESS, BUTTON_RIGHT);
      } else {
        // Send a mouse button release event for the Right button
        LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, BUTTON_RIGHT);
      }
    } else {
      // If mouse emulation is inactive, then send gamepad input to the desired handler (acts as a gamepad)
      LiSendMultiControllerEvent(
        gamepadID, activeGamepadMask, buttonFlags, leftTrigger,
        rightTrigger, leftStickX, leftStickY, rightStickX, rightStickY);
    }
  }
}

// Function to send controller rumble feedback for gamepad
void MoonlightInstance::ClControllerRumble(unsigned short controllerNumber, unsigned short lowFreqMotor, unsigned short highFreqMotor) {
  const float weakMagnitude = static_cast<float>(highFreqMotor) / static_cast<float>(UINT16_MAX);
  const float strongMagnitude = static_cast<float>(lowFreqMotor) / static_cast<float>(UINT16_MAX);
  
  // Check if the rumble feedback switch is checked
  if (rumbleFeedbackSwitch) {
    std::ostringstream ss;
    ss << controllerNumber << "," << weakMagnitude << "," << strongMagnitude;
    PostToJs(std::string("controllerRumble: ") + ss.str());
  }
}
