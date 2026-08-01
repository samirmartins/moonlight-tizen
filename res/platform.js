// Copyright (c) 2015 Samsung Electronics. All rights reserved.

// Dictionary containing key codes used by the input handler.
var tvKey;
// For explanation on ordering, see: https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html
function platformOnLoad(handler) {
  var tvKeyButtons = {
    KEY_0: 48,
    KEY_1: 49,
    KEY_2: 50,
    KEY_3: 51,
    KEY_4: 52,
    KEY_5: 53,
    KEY_6: 54,
    KEY_7: 55,
    KEY_8: 56,
    KEY_9: 57,
    KEY_MINUS: 189,
    KEY_LEFT: 37,
    KEY_UP: 38,
    KEY_RIGHT: 39,
    KEY_DOWN: 40,
    KEY_ENTER: 13,
    KEY_REMOTE_ENTER: 32,
    KEY_RETURN: 10009,
    KEY_MENU: 18,
    KEY_TOOLS: 10135,
    KEY_INFO: 457,
    KEY_SOURCE: 10072,
    KEY_EXIT: 10182,
    KEY_CAPTION: 10221,
    KEY_MANUAL: 10146,
    KEY_3D: 10199,
    KEY_EXTRA: 10253,
    KEY_PICTURE_SIZE: 10140,
    KEY_SOCCER: 10228,
    KEY_TELETEXT: 10200,
    KEY_MTS: 10195,
    KEY_SEARCH: 10225,
    KEY_GUIDE: 458,
    KEY_RED: 403,
    KEY_GREEN: 404,
    KEY_YELLOW: 405,
    KEY_BLUE: 406,
    KEY_PLAY_PAUSE: 10252,
    KEY_REWIND: 412,
    KEY_FAST_FORWARD: 417,
    KEY_PLAY: 415,
    KEY_PAUSE: 19,
    KEY_STOP: 413,
    KEY_RECORD: 416,
    KEY_TRACK_PREVIOUS: 10232,
    KEY_TRACK_NEXT: 10233,
    KEY_VOLUME_UP: 447,
    KEY_VOLUME_DOWN: 448,
    KEY_VOLUME_MUTE: 449,
    KEY_CHANNEL_UP: 427,
    KEY_CHANNEL_DOWN: 428,
    KEY_CHANNEL_LIST: 10073,
    KEY_PREVIOUS_CHANNEL: 10190,
  };
  tvKey = tvKeyButtons;

  if (!handler) {
    console.error('%c[platform.js, platformOnLoad]', 'color: gray;', 'Error: Failed to load input handler!');
    return;
  }

  if (handler.initFn) {
    handler.initFn();
  }

  if (handler.initRemoteController) {
    var event_anchor;
    if (handler.focusId) {
      event_anchor = document.getElementById(handler.focusId);
    } else {
      event_anchor = document.getElementById("eventAnchor");
    }
    if (event_anchor) {
      event_anchor.focus();
    }
  }
  
  if (handler.onKeydownListener) {
    document.addEventListener("keydown", handler.onKeydownListener);
  }

  if (handler.buttonsToRegister) {
    handler.buttonsToRegister.forEach(function(button) {
      tizen.tvinputdevice.registerKey(button);
    });
  }
}
