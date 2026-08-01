# Changelog

All notable changes to this project will be documented in this file.

**Everything from v2.0.0 onwards is this fork.** Everything from v1.13.1 downwards is
the history of [brightcraft/moonlight-tizen](https://github.com/brightcraft/moonlight-tizen),
kept here so the trail back is not lost. The version numbering restarts at v2.0.0 for
that reason: the two lines are separate and should never be read as one.

## v3.3.5

This release keeps the 3.3.4 streaming behaviour while removing unused code,
assets and background work.

### Changed
- Removed legacy mDNS/update UI code, unused fonts, icons, headers and profiling
  infrastructure from the application and build
- Simplified the HTTP dispatcher and made shutdown idempotent
- Canceled subnet discovery before streaming and cleared successful HTTP timeout
  timers instead of leaving callbacks queued on the UI thread
- Skipped overlay-only clocks and cadence calculations while statistics are hidden;
  video timing, decoding, quality and latency settings are unchanged
- Removed two performance lines whose counters were never populated

### Fixed
- Fixed the app-quit refresh running before the cancel request completed
- Reset the bitrate measurement window even while statistics are hidden, preventing
  its counter from wrapping during long sessions

## v3.3.4

This release targets cumulative scheduler, haptics and logging pressure in long sessions.
The v3.3.3 video path is preserved exactly after newer timing experiments proved less
smooth on hardware.

### Fixed
- Idle audio and input workers now sleep until real work arrives. Timed input wakes
  remain only for held-stick mouse movement and the controller long-press timer
- Rumble actuator promises are bounded per controller, with latest-state retry, a
  watchdog for platform promises that never settle, and immediate stop/reset handling
- Periodic performance statistics no longer generate retained console strings
- Controller identity and capabilities are cached at connection time; with rumble off,
  the display-frame callback no longer reads or schedules any haptics work
- Fixed the Audio jitter buffer selector missing the dimensions of every other settings
  button, and made its displayed, stored and native fallback defaults agree

### Changed
- Video timestamps, submission, zero-copy frames, decoder configuration, performance
  instrumentation and presentation behaviour are identical to v3.3.3
- AudioWorklet startup latency, codec, bitrate, resolution, colour handling and visible
  metrics are unchanged
- Audio jitter buffer now defaults to a 100 ms adaptive ceiling, based on the smoother
  hardware result. Playback still starts near two Opus frames and grows only after an
  underrun; the old 50 ms default is migrated once without overriding later user choices

### Added
- Deterministic rumble backlog, watchdog and disabled-path coverage

## v3.3.3

The two timing-sensitive paths that still depended on the browser's main thread have
been rebuilt: PCM rendering and controller haptics. This release also removes duplicate
gamepad work, reports the TV's measured refresh rate to the host, and hardens stream
startup and teardown. The implementation uses capability detection rather than TV model
checks and targets Tizen 5.5 and newer. An initial hardware test on a Samsung DU7700
running Tizen 9.0 with a DualSense over Bluetooth was reported as very smooth.

### Fixed
- **Audio is rendered by an `AudioWorklet` fed from a shared SPSC PCM ring.** Decoded
  Opus no longer creates and schedules one Web Audio source node per packet on the main
  thread. The worklet establishes a small real prebuffer, corrects clock drift smoothly,
  adapts its target after underruns, and keeps a `ScriptProcessor` fallback for engines
  without AudioWorklet support
- **Rumble no longer turns host update rate into work on timing-critical threads.** The
  control stream publishes the newest motor state directly through atomics, browser-side
  updates are coalesced with latest-state-wins semantics, and actuator calls run after the
  animation frame at a maximum of 10 Hz. A zero state is applied immediately and all
  actuator promises are claimed
- **Turning rumble off now disables it at the protocol boundary.** The client does not
  advertise haptics to the host and discards no hidden stream of rumble callbacks, so the
  disabled setting has no per-event cost
- Fixed gamepad snapshots being readable while partially updated. State is now published
  as a coherent atomic snapshot, with stable logical pad slots, correct connection and
  removal events, an accurate active-controller mask, and deduplicated input packets
- Fixed asynchronous JS messages retaining pointers to temporary native memory, and made
  stream flags and input accumulators used across threads atomic
- Fixed teardown paths being able to leave work from the previous session alive. Manual
  stop, connection failure and unexpected termination now share an idempotent cleanup
  path that closes audio and joins the relevant workers before another stream begins

### Changed
- The client refresh rate sent to the host is measured from the TV's animation cadence
  before streaming, with outlier rejection and recognition of common fractional rates,
  instead of assuming that requested stream FPS equals physical display refresh
- Gamepads are sampled once per animation frame and native input is event-driven. The
  periodic wake-up remains only while analog-stick mouse emulation is actively moving
- The existing direct low-latency video submission path, bitrate, resolution, codec and
  colour handling are preserved; the changes do not trade picture quality for smoothness

### Added
- Deterministic native and JavaScript tests for the PCM ring, AudioWorklet, audio fallback,
  gamepad snapshots, post-frame rumble limiting and display refresh estimation

## v3.3.2

A long session was breaking down. Roughly half an hour in, the picture would jump, then
jump again at a similar interval, each time worse, until the stream was unplayable and only
restarting cleared it. Restarting being the cure is the whole clue: it resets state held in
this client and nothing else.

### Fixed
- **The video timeline is now re-anchored when the pipeline is recovered.** The generated
  timeline is an accumulator, and it was reset in exactly one place: setting up a stream.
  When a stall was detected the recovery flushed the pipeline and asked for a keyframe, but
  never touched the accumulator - so it discarded the buffered frames and left the offset
  that caused the stall completely intact. Recovery could not recover. Each cycle began
  further out than the last, which is why the glitches escalated instead of repeating, and
  why only a restart helped. The flush now anchors the timeline onto the position the
  platform reports, advanced to the present, because that reading can be most of a second
  old and anchoring onto it raw would place the timeline in the past
- **The timeline is held against the platform's clock instead of running open loop.** Its
  step is measured from the host's clock while the pipeline plays on the TV's. Two
  independent crystals differ by tens of parts per million and the difference integrates
  without bound; ten to fifteen ppm - entirely ordinary - exhausts a twenty millisecond
  buffer in about half an hour. The distance between the two was already being measured and
  reported as buffer depth; it is now also used. The loop is inert until that distance
  strays past eight milliseconds, which is above the noise on a healthy stream, and it may
  move a frame by at most a twentieth of a millisecond - a fiftieth of what can be seen,
  and fifty times the authority the drift requires
- **A held vibration no longer dies after five seconds.** A magnitude that does not change
  produces no new calls, and the effect was given a five second duration to cover that, so
  a rumble the host held for longer simply stopped. The duration is now one second with an
  explicit renewal well inside it

### Changed
- Rumble effects are capped at twenty a second per pad rather than thirty, and the pair of
  handlers that claims each promise is now shared rather than allocated per call. A pad
  that is meant to be silent produces no calls at all. Shorter effects also bound what is
  outstanding at any moment, which matters if the platform queues effects rather than
  superseding them

### Known issues
- **Rumble is still not fixed, and the recommendation is to play with it off.** With the
  setting enabled there is added latency and a noticeable loss of smoothness. Each release
  since v3.3.1 has reduced what the feature costs and none has brought it to zero, so what
  remains is either inside the platform's own haptics implementation or somewhere this
  client has not yet found. This supersedes the note in v3.3.1 below, which said the
  feature should be safe to enable; on hardware it is not. The setting defaults to off

## v3.3.1

Rumble was costing smooth video. With it switched off the picture was already close to
ideal - 1.62 ms of deviation in frame delivery, 1.65% of frames off cadence - and
switching it on was what pulled those numbers apart. This release makes the feature cost
effectively nothing, so it can be left on.

### Changed
- Rumble no longer crosses threads at all. Each event from the host used to build a string
  through an `ostringstream`, cross to the main thread **synchronously**, be parsed back
  out of that string, call `navigator.getGamepads()` to find the pad, log a concatenated
  line to the console, and only then play the effect - all on the thread that also
  schedules every audio frame. The magnitudes are now published into a word of shared
  memory and read by the animation frame callback that already walks the gamepads to
  publish input. The rate at which the host sends events, which is not the client's to
  control, no longer sets the rate at which the client does work
- Both magnitudes share one 32-bit word, written by a single aligned atomic store, so a
  reader can never catch a new low-frequency value against a stale high-frequency one
- The effect is applied to a pad at most once every 32 ms. A dual-rumble pad drives
  weighted motors whose spin-up and spin-down are measured in tens of milliseconds; they
  cannot express a magnitude that moves at frame rate. This is a floor on the interval
  rather than a delay - the first change after a quiet spell is applied on the very next
  frame, so an impact is never held back, and only a sustained stream of changes is
  thinned. A change that arrives while the floor is in force is not dropped: the next
  frame applies whatever the newest value is by then, rather than a stale one from a queue
- The promises returned by `playEffect` and `reset` are now claimed. A `try`/`catch` does
  not cover a rejected promise, only a synchronous throw, so a pad that disconnected mid
  effect left an unhandled rejection behind - and each of those is reported to the console,
  which is work on the very thread this path exists to keep clear
- Rumble now defaults to off. The work above should make it safe to turn on, and on the
  DU7700 it is, but the default is left off for anyone whose hardware has not been tried
  — **this proved wrong in longer testing; see Known issues under v3.3.2**
- A controller left mid-vibration when a stream ends is now silenced explicitly, rather
  than buzzing until the effect's own duration expires

### Removed
- *Check for updates*, along with the automatic check that ran ten seconds after every
  launch. Both queried the releases of a different repository and compared them against a
  version line that is not the same one, so neither could ever give a correct answer
- The *Support* button and its dialog, which pointed at documentation for another project
- *Unlock all frame rates*, which offered frame rates the panel cannot sustain
- *Optimize bitrate presets*. The standard presets already come from the same table the
  other Moonlight clients use
- A second rumble flag that was written on every stream start and never read anywhere. The
  setting was governed by a different variable, so editing the wrong one would have made
  rumble ignore the setting without a word

## v3.3.0

Everything this client was adding to the stream's timing, removed.

Measured on hardware: with a still picture the host delivers 56 FPS, in motion 59.1,
because capture skips frames that did not change. Frames are two packets long in a
still scene and network latency varies by a millisecond, yet the interval between
frames reaching the platform varied by nearly ten. That gap was ours.

### Changed
- Frames are submitted on the thread that received their last packet, instead of being
  queued for a decoder thread to collect. A handoff whose far end has to be woken by
  the scheduler cannot be tighter than the scheduler is, and on a TV running a dozen
  threads across few cores that is not tight
- The timeline advances at the frame rate actually being delivered, measured as total
  host time over total frames across a window, instead of at the rate that was
  requested. The previous design tried to correct a nominal step towards the host with
  a fifty microsecond cap, while the correction needed ranges from 250 microseconds at
  59.1 FPS to 1190 at 56, so it saturated and never converged. A timeline claiming 60
  while 56 arrive is a cadence the stream cannot sustain
- The audio feeder no longer wakes a thousand times a second. Its condition variable is
  signalled on every arriving packet; the one millisecond timeout was a safety net that
  had become a poll
- Gamepad polling drops from 200 Hz to 125 Hz. State is published by an animation frame
  callback, so polling faster than the display refreshes cannot produce fresher input

### Removed
- The frame pacer, and its setting. Whatever wakes a pacer to release a frame is the
  same scheduler whose unevenness the pacer exists to hide, so a timed hold can never
  be more precise than the wake-up that ends it. Measured on hardware it was worse than
  not pacing at all
- The retry loop around handing a packet to the platform. It now runs on the thread that
  drains the socket, where holding on for another attempt trades a lost frame for lost
  packets

### Added
- The overlay reports the spread of the host's own send interval next to the spread of
  our delivery interval. Side by side they separate a stream the host sent unevenly from
  one this client made uneven, which nothing here could tell before

## v3.2.1

Validated on a Samsung DU7700 streaming at 4K: no complaints about picture or audio.
This is the first release since v2.0.0 to be confirmed on hardware, and everything
between the two was reasoned about rather than measured.

### Fixed
- Fixed the stall detector being able to fire on a healthy stream. It required the reported position to be unchanged for a fixed 750 ms, but the platform's reporting interval is neither documented nor ours to choose: a platform that reports once a second leaves the position legitimately unchanged for that long, and the detector would then flush the pipeline on every reporting interval, turning the protection into the fault. The threshold now calibrates itself against the largest gap observed while presentation was known to be advancing, and only a gap several times longer than anything healthy counts

## v3.2.0

### Fixed
- Fixed *Restore Defaults* leaving three switches showing the opposite of what it saved. *Optimize game settings*, *Rumble feedback* and *Mouse emulation* were stored as on while their switches were set to off, so the screen disagreed with the configuration until the next start
- Fixed audio being discarded whenever the scheduled buffer ran past its target. A network burst pushed the buffer deep and every frame beyond the target was thrown away, which is an audible discontinuity. The buffer is now drained by consuming slightly faster than it arrives, and a frame is only discarded when the backlog is large enough that draining it would hold latency high for many seconds
- Fixed a decoded audio frame being playable after the feeder had reused its slot. The pool was deep enough to make it unlikely and nothing detected it when it happened; each slot now carries a version, the scheduler re-reads it after copying, and a frame spliced from two different moments is counted and dropped instead of played

### Added
- Audio and video are now servoed against each other. The scheduler compares where the pipeline reports it is against how much audio has actually been played, calibrating the fixed offset between the two clocks once per epoch, and corrects the difference through playback rate. Without the epoch calibration the comparison is meaningless: the two timelines have no reason to share an origin
- Presentation stall detection. If the platform keeps accepting packets while the reported position stops advancing, the pipeline is flushed and a keyframe requested, from a worker rather than from the submission path. The detector stays disarmed unless the platform has proved it reports position and that the position was advancing
- The performance overlay reports the share of frames submitted without assembly, hand-over retries and pipeline recoveries

### Changed
- A decode unit that arrives contiguous is handed to the platform where it lies, with no assembly copy. That is every frame except a keyframe, which needs the copy anyway because its H.264 SPS is rewritten in transit
- A refused packet is retried three times with a short backoff before it costs a frame or a keyframe request. The worst case adds under 2 ms, well inside a frame interval
- Each stream stamps a generation onto its audio, so a frame published while the previous stream was being torn down cannot be scheduled against the new stream's clock
- The audio jitter buffer default is 50 ms. It is now the setpoint a rate servo holds rather than a threshold above which audio is dropped, so it no longer has to carry slack for bursts

## v3.1.1

### Fixed
- Fixed gamepad polling putting hundreds of blocking round trips a second on the main thread. `emscripten_sample_gamepad_data`, `emscripten_get_num_gamepads` and `emscripten_get_gamepad_status` are all declared `__proxy: 'sync'` in the SDK, because the Gamepad API only exists on the main thread, so the 5 ms poll on the input worker was six hundred synchronous crossings a second onto the same thread that schedules audio and services the media pipeline. Gamepad state is now read on the main thread by a `requestAnimationFrame` loop, written into the WASM heap, and read from there by the worker without any proxying

## v3.1.0

### Added
- H.264 SPS rewriting. The stream is always low delay, but the SPS the host sends does not say so, and a hardware decoder reading no bitstream restrictions sizes its picture buffer from `level_idc` and holds several frames before showing one. The SPS now declares no reordering, a single buffered frame and a single reference frame, and lowers `level_idc` to the smallest level that fits the resolution. This is the rewrite `moonlight-android` performs on every device since Android 8, and it is staged so it can be narrowed without editing the source
- Opus packet loss concealment. A packet the network lost was previously skipped, leaving a hole in the scheduled audio; the decoder is now asked to conceal it, which also keeps its internal state continuous for the frames that follow
- H.264 is announced alongside HEVC and AV1 as a fallback format, so a host that cannot encode the selected codec negotiates down instead of failing to connect. An explicit H.264 selection is unaffected

### Changed
- Defaults changed for a working out-of-the-box configuration: 1080p at 20 Mbps (was 720p at 10 Mbps), HEVC (was H.264), audio jitter buffer 60 ms (was 100 ms), *Optimize game settings*, *Rumble feedback* and *Mouse emulation* on (all were off), and *Frame pacing* off. The first three match `moonlight-android`; frame pacing matches its `DEFAULT_FRAME_PACING = "latency"`, where the newest frame is presented on arrival rather than held for a deadline
- *Game Mode* now defaults off on every platform version. It selects the EMSS ultra low latency mode, which freezes playback on the first frame on some models, and it is also the switch that must stay off in the ForceGM build where the panel is put into Game Mode by widget metadata. Defaulting it on meant a fresh install could land on the one combination that does not work
- The frame pacer waits against the pipeline's own reported position when the platform provides it, instead of always estimating from local elapsed time, and hands each frame over one frame duration before it is due so the pipeline is never left with nothing in hand
- Audio buffers are drawn from a pool rather than allocated per frame, and the sample conversion no longer looks up the heap view per sample

## v3.0.0

### Fixed
- Fixed the presentation timeline carrying the host clock's quantisation into every frame. moonlight-common-c derives `presentationTimeMs` from the 90 kHz RTP timestamp with an integer division by 90, so at 60 FPS the deltas repeat 16, 17, 17 rather than a uniform 16.667 ms. Following them injected a periodic third of a millisecond of error into each frame's presentation time and into the pacer deadline derived from it. The timeline is now generated at a uniform step, with the step slowly adapted so it stays locked to the host's rate, and the number of frames to advance taken from the frame number rather than the timestamp
- Fixed video track setup continuing after the track was rejected, which produced a stream that opened and showed nothing instead of a clear failure

### Changed
- HEVC below 1440p now declares level 4.1 instead of 5.1. The declared level sizes the decoder's picture buffer: at 1080p, level 5.1 yields a buffer of 16 pictures and level 4.1 yields 6. Configurations are tried in order and fall back to the previous level 5.1 if the decoder rejects the smaller one

## v2.1.0

### Fixed
- Fixed frames being discarded from the bitstream without requesting a keyframe. Once the decode unit queue passed a threshold, P-frames were dropped and reported as handled. The stream carries no periodic keyframes, so the decoder was left referencing a picture it never received and the error propagated until an IDR was requested for some unrelated reason. Rare queue overload is now left to moonlight-common-c, which flushes and requests a keyframe, costing one clean recovery instead of lasting corruption

### Added
- The performance overlay now reports frame delivery interval and its standard deviation, the percentage of frames delivered off cadence, and the depth of the platform's own playback buffer. Averages alone cannot distinguish a steady frame rate from a bursty one

### Changed
- Frame pacing now defaults to on for new installations. Existing settings are preserved

## v2.0.0

First release of this fork, branched from upstream v1.13.1.

### Fixed
- Fixed video stuttering caused by the frame pacer busy-waiting on the decoder thread, and by its once-a-second step correction releasing held frames in a burst
- Fixed the video timeline drifting shorter on every lost frame, by following the host presentation clock instead of counting accepted frames
- Fixed audio stuttering by rendering audio through the Web Audio API instead of the Tizen elementary media source, whose audio track shares the pipeline that stutters
- Fixed Opus decoding running on the UDP receive thread, where any stall became real packet loss
- Fixed gamepad polling continuing on the main thread during streaming

### Changed
- The dead *Audio synchronization* toggle is now an *Audio jitter buffer* slider (50–500 ms, default 100)
- Builds with `-O3` instead of `-Os`
- Reports the client refresh rate and colour space to the host
- Widgets are named after the version and variant, and the ForceGM variant builds from the same tree with `--build-arg FORCE_GAME_MODE=1`

---

# Upstream history

Everything below is [brightcraft/moonlight-tizen](https://github.com/brightcraft/moonlight-tizen),
before this fork existed. None of it is my work.

## v1.13.1

### Fixed
- Fixed an issue where hosts could fail to recover correctly after coming back online
- Fixed an issue where offline hosts could incorrectly appear as online after becoming unreachable
- Fixed an issue where cached app lists could remain accessible after the host was disconnected
- Fixed an issue where streaming sessions could fail to reconnect after disconnecting in some cases
- Fixed an issue where automatic host discovery could occasionally fail to find new hosts
- Fixed an issue where gamepad shortcuts did not work when multiple gamepads were connected
- Fixed an issue where certain gamepads could unexpectedly stop responding during streaming
- Fixed an issue where gamepad action buttons would trigger rapidly when held down during UI navigation

## v1.13.0

### Added
- Added automatic local network host discovery using a HTTP subnet scanner
- Added support for IPv6 addresses and DNS hostname when connecting to hosts
- Added Wake-on-LAN (WoL) support for hosts connected via IPv6 networks
- Added centered status icons to indicate whether hosts are offline or unpaired

### Changed
- Optimized dependency downloads to significantly reduce Docker image build times

### Fixed
- Fixed an issue where automatic host discovery could occasionally restore outdated IP addresses
- Fixed a race condition where the first app was selected before the app list had fully loaded
- Fixed pairing deadlocks causing pairing requests to remain stuck after canceling
- Fixed network hangs that could leave the app stuck on the 'Loading Apps' screen

## v1.12.1

### Changed
- Optimized the Docker build process with persistent cache mounts for faster builds
- Prevented selection of resolutions unsupported by the TV's hardware capabilities
- Excluded hidden files and directories to prevent unnecessary Docker cache busting
- Updated the Tizen certificate keystore password to meet minimum password requirements

### Fixed
- Fixed pairing failures with Sunshine using a randomly generated unique client ID
- Fixed an issue where canceling the pairing dialog would cause subsequent pairing attempts
- Fixed logging in the NvHTTP constructor to prevent undefined values from being printed
- Fixed a deserialization bug where newly revived hosts failed to inherit their properties correctly

## v1.12.0

### Added
- Introduced a new 'Optimize bitrate presets' setting to calculate optimal bitrate values
- Implemented handling of standard and optimized bitrate presets based on toggle state

### Changed
- Improved release notes extraction and formatting for better readability
- Updated 'System info' placeholder and reduced redundant API calls across the codebase
- Updated versioning logic to inject build metadata for identifying pre-releases
- Disabled 'Game mode' setting for Tizen 5.5 due to lack of support from WASM player
- Updated bot-stale workflow to restrict exempted issue labels
- Configured workflow to close issues if the author does not respond to a request for more information

### Fixed
- Fixed broken OpenSSL download URL in Emscripten SDK ports
- Fixed an issue where multiple elements could remain focused during navigation

## v1.11.1

### Added
- Added helper functions to resolve DOM elements from various target types
- Added helpers for resolving element ID and safely handling focus and blur
- Added helper for safely clicking elements with disabled state checks

### Changed
- Refactored mark and unmark to use resolve element function and removed duplication
- Applying DOM helper utilities across views and improve navigation behavior
- Enhanced MDL dropdown menu handling for selection and closing
- Improved navigation and UI behavior in 'Add Host' dialog and applied style fixes
- Unifying gamepad and remote control selection logic using a single view handler

### Fixed
- Fixed toggle switch behavior and ensured consistent handling across Tizen versions

## v1.11.0

### Added
- Added support for custom ports when connecting and pairing with a host
- Added HTTP port sanitization and fallback to default on invalid values
- Added input validation for IP address and optional port in the text field

### Changed
- Fallback to default port when entering an IP address using numeric fields

### Fixed
- Fixed host polling execution in background after deletion
- Fixed navigation index out of bounds upon host deletion
- Fixed navigation input being active during loading screens
- Fixed a bug in the pairing process that was causing random pairing failures

## v1.10.3

### Added
- Added the Patreon platform for project support

### Changed
- Refactored Dockerfile to remove unused dependencies and steps
- Disabled monthly USB package release schedule and enabled manual trigger
- Replaced the snackbar with a proper dialog in DialogMsg and ignored .DS_Store
- Optimized Dockerfile to cache backend build layers during frontend changes
- Improved issue templates and included 'Discussions' link for quick interaction

## v1.10.2

### Changed
- Updated QR code in the 'Support' dialog that redirects to the correct Wiki page

### Fixed
- Fixed issue where SDB and other Tizen Studio tools were removed during Docker image cleanup

## v1.10.1

### Changed
- Configured workflow to mark inactive issues as stale and close them after a certain period of time
- Updated 'Compatibility Warning' dialog to simplify message for affected Tizen platform
- Updated 'h264bitstream' library to fix a potential memory leak and improving stability
- Improved Dockerfile by refining multi-stage build and cleanup to reduce image size
- Disabled USB package creation due to the USB Demo packaging tool being discontinued by Samsung

### Removed
- Eliminated the need to restart Moonlight after selecting a video codec or audio configuration

## v1.10.0

### Added
- Introduced a new 'Game mode' setting that allows changing the game mode state
- Added a new 'Warning' dialog and corresponding view to display warning messages
- Implemented functionality for the game mode switch with proper handling across Tizen versions
- Handled video latency modes based on toggle switch state during stream start request

### Changed
- Refactored media source pipelines and reinitialized video decoding configuration at stream startup
- Renamed 'UI Settings' category to 'Advanced Settings' and adjusted its order
- Reorganized settings by relocating options into better structured categories
- Reordered Tizen privileges, settings, and metadata entries in the app configuration

## v1.9.2

### Added
- Added workflow for building and publishing development releases with associated files

### Changed
- Reverted HEVC and AV1 codec profiles to previous level to allow higher stream settings

### Fixed
- Fixed issue where the 'Add Host' container wasn't focused after splash screen loaded
- Fixed issue with 'Quit Running App' button not focused properly after stopping the game
- Fixed issue where cancelling 'Exit Moonlight' dialog added double focus to host containers
- Fixed issue with the running game card not correctly reflecting the active game session

## v1.9.1

### Added
- Added badges to settings options to indicate new, preview, or experimental features

### Changed
- Refined multiple settings descriptions to provide clearer context and usability
- Updated the workflow file for stable releases and changed to manual trigger for the master branch
- Improved the workflow process for USB releases, updated the release notes, and made minor fixes

## v1.9.0

### Added
- Added a new 'UI Settings' category for interface customization options
- Introduced a new 'Unlock all frame rates' setting to enable higher FPS options
- Implemented handling for unlocking all FPS options based on toggle switch state
- Expanded the 'Unlock all frame rates' setting with a new '144 FPS' option

### Changed
- Rearranged settings by moving options into more appropriate categories
- Adjusted high-resolution scroll event scaling factor for smoother wheel input

## v1.8.1

### Added
- Added extra buffer space for IDR frames to accommodate potential SPS fixup

### Changed
- Expanded initial decode buffer size from 128 KB to 1 MB to improve playback stability
- Reduced the level profiles of all video formats to ensure better device compatibility
- Refined on-screen overlays for better alignment to screen edges and improved readability

### Fixed
- Fixed an issue where server polling continued in the background during an active stream session

## v1.8.0

### Added
- Introduced a new 'Performance statistics' setting that displays performance information while streaming
- Implemented functionality to toggle the performance stats switch and save changes
- Added on-screen overlay for performance statistics shown only during streaming sessions
- Added functionality to aggregate metrics and present detailed statistics in a formatted output
- Added accurate tracking, calculation, and measurement logic for video performance statistics
- Handled performance stats updates and displayed metrics derived from stream performance
- Implemented shortcut functionality to toggle performance stats via remote control, keyboard, and gamepad

## v1.7.1

### Added
- Added loading screens to 'Hosts', 'Apps', and 'Settings' views for smoother transitions
- Added functionality to support posting messages asynchronously to the main thread
- Defined MIN and MAX macros for cleaner value comparisons across the codebase

### Changed
- Improved handling of stream termination to prevent video display from remaining stuck

### Fixed
- Minor bug fixes, code refactoring and general improvements

## v1.7.0

### Added
- Introduced a new 'Connection warnings' setting that disables warning messages while streaming
- Implemented functionality to toggle the connection warnings switch and save the changes
- Added on-screen overlay for connection warnings shown only during streaming sessions
- Handled connection status changes and provided warnings based on connection quality

### Changed
- Extended host object with additional server info and applied validation checks
- Updated 'Host Details' dialog to display additional server info with fallback validation

## v1.6.1

### Added
- Added encryption flag to stream configurations that disables encryption support

### Changed
- Updated 'Restart Moonlight' dialog to display appropriate message based on the restart request

### Fixed
- Fixed image tag setup in scheduled workflow to use the correct Docker image tag
- Fixed navigation view issues caused by pressing the RED key outside stream session
- Fixed mouse wheel scroll direction issue caused by previously disabled floating menu

## v1.6.0

### Added
- Introduced a new 'Audio configuration' setting that allows selection of audio channels
- Added a navigation view to interact with the new 'Audio configuration' setting
- Implemented functionality to save value and initiate the stream with preferred audio config
- Added a warning message when selecting 5.1 or 7.1 surround sound options
- Handling of audio channels based on the selected audio configuration option

### Changed
- Enhanced audio decoding logic to support 5.1 and 7.1 surround audio channels

## v1.5.1

### Added
- Added issue templates for bug report and feature request with selection options
- Added workflow for scheduled release USB method with associated file

### Changed
- Improved pull request template with structured sections and helpful instructions
- Improved workflow for automated release publishing with associated file

### Removed
- Removed the 'Buy Me a Coffee' funding platform due to regional restrictions

### Fixed
- Minor bug fixes, code refactoring and general improvements

## v1.5.0

### Added
- Introduced a new 'Color range' setting that enables full color range while streaming
- Implemented full color range handling based on toggle switch state
- Added hardware decoding mode flag for audio and video playback configurations

### Changed
- Increased the maximum bitrate slider for the bitrate menu from '120 Mbps' to '150 Mbps'

### Fixed
- Fixed focus issue on 'Continue' button after toggling its disabled state in the 'Add Host' dialog
- Fixed an issue with the running game card style not being applied when navigating to the 'Apps' view

## v1.4.1

### Added
- Implemented auto-checking for new Moonlight updates at application startup
- Notify and add a new 'Update Moonlight' button to view update release notes

### Changed
- Preventing API requests by limiting the interval when performing update checks at startup
- Ensured that server information is refreshed before background polling of the host begins
- Renamed 'Advanced Settings' category to 'Video Settings' to better align with the relevant settings

### Dependencies
- Updated 'tizen-studio' tool from v5.6 to v6.1

## v1.4.0

### Added
- Added a new 'Audio Settings' category which will contain audio settings
- Added 'HDR mode' parameter to launch and resume requests to auto-toggle HDR on host PC

### Changed
- Reorganized settings by moving options across different categories for better grouping
- Improved handling of video codec selection and HDR mode state for better value determination
- Enhanced server codec mode support for proper value handling based on the selected video format

### Fixed
- Fixed validation of non-pinned TLS trusted certificates

## v1.3.1

### Changed
- Improved manual release update checking and eliminated redundant code
- Renamed 'Decoder Settings' category to 'Advanced Settings' for better understanding
- Improved settings view handling, navigation control, and reduced repetitive code
- Refined setting labels and option names for improved clarity and usability
- Improved Java configuration for Emscripten and bypassed Java check for Tizen Studio

### Fixed
- Fixed incorrect conditions causing toggle switches to misinterpret their default state

## v1.3.0

### Added
- Added a new 'System Update' icon for the 'Check for Updates' button
- Introduced a new 'Check for Updates' button to check for new Moonlight updates
- Implemented version comparison and release notes extraction for new updates
- Introduced a new 'Update Moonlight' dialog and its corresponding view
- Implemented version info and release notes in the 'Update Moonlight' dialog

### Fixed
- Minor improvements, code refactoring, and rearrangement across the application

## v1.2.20

### Added
- Added warning messages for resolution, frame rate, bitrate, and codec selection

### Changed
- Simplified setting descriptions to improve readability and reduce unnecessary details
- Updated '480p' video resolution setting for better standardization and compatibility
- Rearranged elements for better code structure, organization, and readability

### Fixed
- Fixed an issue where the bitrate slider was ignoring decimal values due to incorrect parsing

## v1.2.19

### Added
- Added more system details and improved structure in the 'System Info' placeholder

### Changed
- Changed the default video resolution setting from '1080p' to '720p'
- Increased the minimum bitrate slider for the bitrate menu from '0 Mbps' to '0.5 Mbps'
- Changed the default video bitrate setting from '20 Mbps' to '10 Mbps'
- Improved Dockerfile with the 'wgt-to-usb' tool for generating a USB installer

### Fixed
- Minor bug fixes, code refactoring and general improvements

## v1.2.18

### Added
- Added a new 'Tizen' metadata: 'Floating Navigation' to disable the floating menu in the app
- Added 'Optimize Games Settings' and 'Play Audio on PC' settings to the stream start request

### Changed
- Improved handling of layout elements for displaying the stream view

### Fixed
- Fixed an issue where stream settings and parameters did not apply when resuming an app
- Fixed an issue where repeated clicks on host and game containers caused multiple instances of streaming sessions

## v1.2.17

### Added
- Added new snackbar messages for additional cases of unexpected streaming termination

### Changed
- Partially reverted audio sync and video player changes to their original implementation
- Enhanced comments, console logs, and snackbar messages for improved debugging and clarity

### Dependencies
- Updated 'opus' module from v1.4 `c854997` to v1.5.2 `ddbe483`

## v1.2.16

### Added
- Implemented scrolling navigation to the previous or next card in the 'Hosts' and 'Apps' views
- Implemented scrolling navigation to the current card row in the 'Hosts' and 'Apps' views

### Fixed
- Fixed an issue where the game card was not focused when entering or returning to the 'Apps' view
- Fixed an issue where the focused card row did not scroll when entering or returning to the 'Hosts' and 'Apps' views
- Fixed an issue where the app list was not refreshed after selecting the host container
- Fixed an issue where the 'Quit App' dialog would appear even if no app or game was running

## v1.2.15

### Added
- Added a scrolling text animation for host and game titles when focusing on the card

### Changed
- Improved the structure of the host and game containers by refining all their elements
- Enhanced styling and visibility in the 'Hosts' and 'Apps' views for rows, cards, and titles
- Improved navigation in the 'Hosts' and 'Apps' views while reducing repetitive code

### Fixed
- Fixed a scrolling issue with host and game cards due to navigation delay
- Fixed minor navigation issues across different views to improve stability

## v1.2.14

### Changed
- Enhanced styling and visibility for the header, navigation bar, and buttons
- Improved size and styling of snackbar logs, tooltips, and dialogs for better readability
- Enhanced button styling across the app and refined dialog text appearance
- Improved styling in the 'Add Host' dialog for both IP address field modes to ensure clarity
- Updated the content and style of the 'Navigation Guide' dialog for better readability
- Enhanced visibility and styling in the 'Settings' view for categories, options, menus, and icons

## v1.2.13

### Added
- Added the application logo with animation to the splash screen

### Changed
- Increased the spinner size with rounded corners and enhanced text visibility
- Adjusted the size of the 'Add Host' and 'Host Container' icons for better visibility
- Moved the 'icons' folder to the 'static' directory for better organization of assets
- Replaced the function to stop the streaming session with the correct one for keyboard input

### Removed
- Removed unused styling properties and incompatible event listeners

### Fixed
- Fixed a performance issue when navigating game cards in the 'Apps' view

## v1.2.12

### Added
- Added the 'Tizen' profile: 'TV Samsung' to determine the type of device used in the application

### Changed
- Disabled the 'ChromeOS' network service discovery feature, which is not compatible with Tizen OS

### Removed
- Removed the 'Exit app' button from 'Settings' that was used to immediately terminate the app
- Removed the 'Game Mode' metadata to prevent app crash issue when starting streaming on newer Tizen OS

### Fixed
- Fixed an issue with the application icon file path causing a configuration error
- Fixed an issue during address polling when the host status is online or offline
- Fixed a focus issue on the 'Settings' button when returning to the 'Hosts' navigation bar

## v1.2.11

### Added
- Introduced a new 'HDR mode' setting that allows HDR streaming on HDR-capable devices
- Implemented logic to load the stored HDR value and start the stream in HDR mode
- Implemented functionality to update and save the video codec value and the HDR state

### Changed
- Handled switching between standard and Main10 codec profiles based on selected codec and HDR state
- Improved the 'Video codec' setting to better handle codec switching during HDR state changes
- Updated the QR code in the 'Support' dialog that redirects to the new guide

## v1.2.10

### Added
- Introduced a new 'Wake On LAN' feature for waking up the host PC
- Implemented functionality to update and store the valid MAC address for the host PC
- Added a new 'Wake PC' option to the 'Host Menu' dialog to allow waking the host PC
- Introduced a new 'Host Details' dialog and its corresponding view
- Added a new 'View details' option to the 'Host Menu' dialog to view host details

### Fixed
- Minor bug fixes, code refactoring and general improvements

## v1.2.9

### Added
- Added a new 'Menu' icon for the 'Host Menu' button
- Introduced a 'Host Menu' button to show host button options
- Introduced a new 'Host Menu' dialog and its corresponding view
- Implemented functionality to clear box arts from internal storage
- Added a new 'Refresh apps' option to the 'Host Menu' dialog to refresh apps and games
- Added a new 'Delete PC' option to the 'Host Menu' dialog to allow removing the host PC

## v1.2.8

### Added
- Introduced a new 'Flip A/B face buttons' setting that swaps the 'A' and 'B' button mapping for the gamepad
- Introduced a new 'Flip X/Y face buttons' setting that swaps the 'X' and 'Y' button mapping for the gamepad
- Implemented logic to handle different layouts of gamepad face buttons based on toggle state

### Changed
- Optimized functionality to save and load box arts to internal storage for better performance

## v1.2.7

### Added
- Added a new 'Input Settings' category which will be used to hold input settings
- Introduced a new 'Rumble feedback' setting that allows changing the state of the rumble feature for the gamepad
- Introduced a new 'Mouse emulation' setting that allows changing the state of the mouse feature for the gamepad

### Fixed
- Minor bug fixes, improved visual styling and general improvements

### Dependencies
- Updated 'material-icons' library to the latest version

## v1.2.6

### Added
- Introduced a new 'Sort apps and games' setting to change the sorting order of apps and games
- Implemented functionality to change the sort order for the list of apps and games

### Fixed
- Fixed a warning issue where casing did not match for 'as' and 'FROM' keywords

### Dependencies
- Updated 'moonlight-common-c' module from `48d7f1a` to `8599b60`

## v1.2.5

### Added
- Implemented functionality to handle repeat actions and navigation delay for gamepad while in-app
- Implemented a workaround to send the escape key to the host by pressing the ESC key twice on the keyboard

### Removed
- Removed global navigation delay from remote control while in-app

### Fixed
- Minor bug fixes and refactored code for improved readability

### Dependencies
- Updated 'tizen-studio' tool from v5.5 to v5.6

## v1.2.4

### Added
- Added a new 'Navigation' icon for the 'Navigation Guide' button
- Introduced a new 'Navigation Guide' button to learn about navigation controls
- Introduced a new 'Navigation Guide' dialog and its corresponding view
- Implemented functionality for handling the 'Navigation Guide' dialog

### Changed
- Minor enhancements in visual stylization and general improvements

## v1.2.3

### Added
- Added a new 'Tizen' metadata: 'Game Mode' which enables the app to use game mode
- Added the 'Buy Me a Coffee' platform for developer support

### Changed
- Show the 'Restart Moonlight' dialog after restoring default settings instead of the snackbar
- Quick switching to the alternate IP address field can now be done by pressing 'Channel Up/P+' or 'Select/Back' button

### Fixed
- Fixed an issue with the server codec mode support value not displaying correctly

## v1.2.2

### Added
- Added a new 'Tizen' privilege: 'Media Storage' that gives access to the TV's internal storage
- Added additional detailed logging for debugging purposes

### Changed
- Improved existing logs for better debugging and understanding

### Fixed
- Refactored code for improved readability and maintainability

## v1.2.1

### Added
- Introduced a new 'Mouse Emulation' feature for gamepad input
- Added snackbar notifications for mouse emulation state changes
- Implemented logic to handle mouse movements with the Left Stick
- Implemented logic to handle mouse scrolls with the Right Stick
- Implemented logic to handle mouse buttons with the Face Buttons

## v1.2.0

### Added
- Introduced 'AV1' as a new video codec option in the 'Video codec' settings
- Implemented logic to handle server codec mode support checks
- Added the High Level 5.1 profiles for AV1 and AV1 Main10 codecs

### Fixed
- Fixed navigation issues when switching between views

## v1.1.20

### Added
- Added a new 'Tizen' metadata: 'Voice Guide' which disables the voice guide in the app
- Implemented navigation to go to the previous or next row in 'Hosts' view
- Added a navigation delay for the bitrate slider when adjusting the value
- Implemented navigation to go to the previous or next option in 'Settings' view

### Fixed
- Refactored code for improved structure and readability

## v1.1.19

### Added
- Added a new 'Tizen' privilege: 'Fullscreen' which allows the application to use the full screen view
- Disabled the 'Continue' button to prevent multiple connection requests when adding a host
- Re-enabled the 'Continue' button upon successful, failed or cancel processing when adding a host

### Changed
- Enhanced visual styling across multiple elements in the application

### Fixed
- Fixed a navigation issue to ensure proper bound checking for previous/next row

## v1.1.18

### Added
- Added a FUNDING file to enable project funding based on supported model platforms
- Implemented logic to handle focus for the active element based on the IP address switch state

### Changed
- Enhanced navigation controls for the 'Add Host' dialog view
- Updated implementation logic to initialize IP address fields with predefined values

### Fixed
- Fixed navigation issue after removing a host, preventing focus from shifting out of view

## v1.1.17

### Added
- Introduced a new 'IP address field mode' setting to change the field mode when entering the IP address
- Implemented functionality to toggle and save the preferred mode for the IP address field

### Changed
- Enhanced the 'Add Host' dialog to provide two different IP address fields
- Improved navigation for the 'Add Host' dialog view to support both IP address fields

## v1.1.16

### Added
- Added additional navigation controls for special cases
- Added the ability to remove a host by pressing 'Channel Up/P+' (remote) or 'Select/Back' (gamepad) while hovering over the host
- Implemented a rumble vibration effect when the gamepad is connected

### Fixed
- Minor bug fixes and general improvements

## v1.1.15

### Added
- Added a new 'Restart' icon for the 'Restart App' button
- Introduced a 'Restart App' button for instant application restart
- Added additional query parameters for launch and resume requests

### Fixed
- Refactored code for improved structure and readability

## v1.1.14

### Added
- Added a new 'Drop Down' icon for multi-select buttons

### Changed
- Adjusted the size of the 'Add Host' and 'Host Container' icons for better visibility
- Changed the color of the 'Power Off' icon to white as the default
- Enhanced the visual stylization application-wide

## v1.1.13

### Added
- Expanded settings: Reintroduced '90 FPS' frame rate option
- Added bitrate presets for '90 FPS' frame rate option

### Changed
- Improved visibility and readability of tooltips
- Improved snackbar design for enhanced user experience

## v1.1.12

### Added
- Introduced a new 'Video codec' setting that allows selection of video codec
- Implemented functionality to select, save, and initiate the stream with the preferred video codec
- Introduced a new 'Restart Moonlight' dialog and its corresponding view
- Implemented functionality for handling the 'Restart Moonlight' with confirmation dialog
- Added a navigation view for interacting with the new 'Video codec' setting

## v1.1.11

### Added
- Added snackbar notification to warn user to restart app after restoring default settings

### Changed
- Updated the icon of the 'Quit Running App' button for improved appearance
- Improved the snackbar notifications when quitting the running app to provide better clarity
- Upgraded H.264 codec from High Level 4.2 to High Level 5.1 profile

### Removed
- Removed audio encryption flags from stream configurations

### Fixed
- Minor bug fixes and general improvements

## v1.1.10

### Added
- Added bitrate presets for '120 FPS' frame rate option
- Added workflow for automated Docker image publishing

### Changed
- Optimized Dockerfile using multi-stage build to reduce Docker image size

### Fixed
- Fixed gamepad button mapping issue with 'X' and 'Y' buttons

## v1.1.9

### Added
- Added a new 'Power Off' icon for the 'Exit App' button
- Introduced a 'Exit App' button for immediate application termination

### Changed
- Enhanced the visual stylization of the 'Settings' container

### Fixed
- Fixed control navigation issues in multiple views

## v1.1.8

### Added
- Introduced a new 'Restore Defaults' button in the 'Settings' navigation bar
- Introduced a new 'Restore Defaults' dialog and its corresponding view
- Implemented a function to reset all settings to their default values
- Implemented functionality for handling the 'Restore Defaults' with confirmation dialog

## v1.1.7

### Added
- Added a new 'About' category that contains a 'System Info' button as a placeholder
- Added three new 'Tizen' privileges that grant access to app and system information
- Implemented functionality to load system information in the 'System Info' button
- Implemented all navigation views for full interaction within the 'Settings' container
- Implemented navigation to go to the previous or next category in 'Settings' view
- Implemented functionality to handle category clicks and show the settings options in the right pane

## v1.1.6

### Added
- Introduced a new 'Settings' button and created a 'Settings' container
- Implemented functionality for managing the 'Settings' container
- Grouped all settings categories and added them to the left pane of the container
- Expanded settings: Reintroduced '120 FPS' frame rate option

### Changed
- Increased the maximum bitrate slider for the bitrate menu from '100 Mbps' to '120 Mbps'
- Grouped and migrated existing settings options to the right pane of the container
- Converted all settings using 'Material Icon Toggle' to the 'Material Switch' for improved appearance

## v1.1.5

### Added
- Introduced a new way to stop the streaming session using the RED key on the remote control
- Implemented a reusable function for terminating the application

### Changed
- Improved host deletion functionality

### Fixed
- Minor bug fixes and general improvements
- Refactored code for improved structure and readability

### Dependencies
- Updated 'moonlight-common-c' module from `3ed3ba6` to `48d7f1a`

## v1.1.4

### Added
- Added gamepad timestamp for accurate detection of valid gamepads

### Changed
- Rearranged elements for improved structure
- Minor enhancements in visual stylization application-wide

### Fixed
- Fixed header display issues during the loading of host and game views
- Refactored code for improved structure and readability

## v1.1.3

### Changed
- Improved the header style for better appearance
- Updated the navigation logo and title to dynamically change based on the current view
- Enhanced the visual presentation of the host and game grids
- Enhanced the appearance of buttons in the navigation bar

### Removed
- Removed unnecessary media queries from the styling

## v1.1.2

### Changed
- Changed the root directory name for the build package
- Updated directory paths for certain core files

### Removed
- Removed all unnecessary core files of the 'ChromeOS' version
- Removed all unnecessary code components of the 'ChromeOS' version

### Fixed
- Fixed spelling errors in the code

## v1.1.1

### Changed
- Decreased the maximum bitrate slider for the bitrate menu from '150 Mbps' to '100 Mbps'
- Improved text readability of the 'Pairing' and 'Support' dialogs
- Improved the stream settings structure for better clarity

### Dependencies
- Updated 'tizen-studio' tool from v5.1 to v5.5

## v1.1.0

### Changed
- Updated stream configurations to align with the latest versions of modules

### Dependencies
- Updated 'moonlight-common-c' module from `50c0a51` to `3ed3ba6`
- Updated 'opus' module from v1.4 `82ac57d` to v1.4 `c854997`

## v1.0.20

### Changed
- Improved audio synchronization for a better streaming experience
- Reverted the order of combination keys for keyboard to the previous configuration for stopping streaming sessions
- Adjusted the bitrate presets for each resolution and frame rate options
- Improved the structure of the 'Wasm Player' and added comments to improve code clarity and understanding

### Removed
- Temporarily removed the '90 FPS' and '120 FPS' frame rate options due to functionality issues causing screen freezes

## v1.0.19

### Added
- Added additional TV key buttons and associated key codes
- Added and included a favicon created for the homepage
- Added snackbar notifications for gamepad connection and disconnection events

### Changed
- Improved navigation functionality for both remote control and gamepad input methods

### Removed
- Removed the sound effects to resolve a black screen issue occurring during stream startup

## v1.0.18

### Added
- Added a validation for 'IP Address' input field which allows only a maximum of 15 numerical characters
- Implemented the action of clearing the 'IP Address' input field after successful processing

### Changed
- Minor enhancements in visual stylization

### Fixed
- Fixed the gamepad disconnection issue
- Fixed the 'Volume UI' issue where it would not appear when changing the volume on the TV
- Refactored code for improved structure and readability

## v1.0.17

### Added
- Added a new 'Tizen' privilege: 'IME' which allows entering characters and symbols into text field
- Implemented navigation to go to the previous or next row in 'Apps' view

### Changed
- Improved error handling for missing audio capture device

### Fixed
- Fixed navigation blockage caused by bitrate slider sticking issue in 'Hosts' navigation bar

## v1.0.16

### Added
- Added additional app icon sizes
- Introduced sound effects to enhance the app experience

### Changed
- Minor enhancements in visual stylization

### Fixed
- Refactored code for improved structure and readability

## v1.0.15

### Added
- Added a snackbar notification for offline hosts
- Implemented logic to handle the Left Stick axis for in-app navigation
- Implemented a delay for smoother in-app navigation

### Changed
- Changed bitrate to custom presets for more options
- Updated tooltip text for all 'Settings' options

### Fixed
- Fixed spelling errors in the code

## v1.0.14

### Added
- Expanded settings: Introduced '90 FPS' and '120 FPS' frame rate options

### Changed
- Increased the maximum bitrate slider for the bitrate menu from '100 Mbps' to '150 Mbps'
- Updated server codec and video format

### Fixed
- Fixed focus navigation issue for settings items
- Fixed bitrate presets for '90 FPS' and '120 FPS' frame rate options
- Fixed the order of combination keys for both keyboard and gamepad buttons to stop streaming sessions

## v1.0.13

### Changed
- Updated all core implementation files for 'Tizen'

### Dependencies
- Updated 'opus' module from v1.1.3 `f6f8487` to v1.4 `82ac57d`

## v1.0.12

### Added
- Introduced a new 'Rumble Feedback' feature for gamepad input

### Changed
- Updated video codecs to a newer version
- Updated all core implementation files for 'ChromeOS'

### Removed
- Removed the 'SLOW_AUDIO_DECODER' condition to resolve a garbled audio playback issue occurring at the beginning of the stream

## v1.0.11

### Added
- Introduced a new 'Support' button and a new 'Support' dialog
- Added the QR code to 'Support' dialog which redirects to a guide
- Implemented functionality for handling the 'Support' dialog

### Changed
- Minor enhancements in visual stylization application-wide

## v1.0.10

### Added
- Introduced a new button: 'Remove All Hosts' in the navigation bar
- Implemented functionality for handling the 'Remove All Hosts' with confirmation

### Fixed
- Fixed control navigation issues in multiple views
- Refactored code for improved structure and readability

## v1.0.9

### Added
- Introduced a new 'Pointing Device' feature for mouse input
- Added tooltip for 'Back' icon button
- Enhancement the UI: Added 'Overlay' for all dialogs

### Changed
- Enhanced overall visual stylization application-wide

## v1.0.8

### Added
- Disabled text selection highlighting application-wide

### Changed
- Reverted a change and added comments for improved code clarity
- Optimized control navigation application-wide

### Fixed
- Refactored code for improved structure and readability

## v1.0.7

### Added
- Enhanced card hover styles for better appearance

### Changed
- Aligned 'Add Host' and 'Hosts PC' text to the center
- Increased the font size application-wide for better readability
- Changed the text content in the 'Pairing' dialog for better clarity
- Improved the readability of dialog texts and snack bar logs

## v1.0.6

### Added
- Enhanced button focus styles for better appearance

### Changed
- Adjusted the width of dialogs application-wide
- Adjusted padding for title and content text in dialogs
- Increased the width of the input field in the 'Add Host' dialog
- Adjusted dialog buttons to increase their size

## v1.0.5

### Added
- Introduced a new 'Exit Moonlight' dialog
- Implemented dynamic handling for 'Exit Moonlight' dialog
- Show 'Exit Moonlight' dialog via 'Back' button on 'Hosts' view

## v1.0.4

### Added
- Added comments to improve code clarity and understanding

### Changed
- Updated '480p' resolution setting
- Updated default bitrate setting from '10 Mbps' to '20 Mbps'
- Reordered 'STOP_STREAM_BUTTONS_FLAGS' buttons

## v1.0.3

### Added
- Expanded settings: Introduced '480p' resolution option
- Added bitrate presets for '480p' resolution option

### Changed
- Changed default bitrate presets and resolution settings from '720p' to '1080p'

## v1.0.2

### Changed
- Updated the 'Frame Pacing' icon for better appearance in the Settings menu
- Enhanced dialog and error messages application-wide

### Removed
- Removed extra white spaces and code formatting

### Fixed
- Fixed spelling errors in the code

## v1.0.1

### Changed
- Dockerfile has been updated for the build process
- Updated widget name and description
- Improved app logo icons for enhanced appearance in the Smart Hub

## v1.0.0

### Added
- Expanded settings: Introduced '1440p' resolution option
- Added bitrate presets for '1440p' resolution option
- Added a new 'Tizen' privilege: 'TV Audio' which allows to change the volume in the application
- Expanded TV key functionality to allow changing the volume from the remote control
- Implemented 'STOP_STREAM_BUTTONS_FLAGS' condition to specify a combination of buttons on the gamepad for stopping streaming sessions
