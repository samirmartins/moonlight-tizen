# Build tools

This guide separates regression checks, development builds and release signing.
The public recipes remain available; their presence is not proof of a completed
end-to-end build or compatibility with an existing installation.

## Tests and GitHub Actions

From the repository root:

```bash
bash build-tools/run-tests.sh
```

Runs every `wasm/*_test.js` and six standalone C++ tests: audio ring, concurrent
PCM stress, dispatcher, video timing, telemetry and mocked Wake-on-LAN.
The JavaScript entries also compile native fixtures for RTSP/Opus, input focus,
codec setup, decoder errors, session teardown, certificates and H.264 pixel equality.
Historical source-identity checks are consolidated in `scope_contract_test.js`;
they enforce approved scope, not performance. Baselines must not be refreshed
silently to make a failing test pass.
Dependencies: Node.js 22, GCC/G++, FFmpeg with libx264, OpenSSL development headers
and Git/GNU timeout. Native fixtures use ASan/UBSan.
The runner checks completion markers, rejects unhandled rejections, bounds each
process and cleans temporary files, including failed runs.
The current comparisons require tags `v3.3.8`, `v3.3.10`, `v3.4.0`, `v3.4.1`, `v3.4.2`, `v3.4.3`, `v3.4.4` and `v3.4.7`;
use a full checkout. CI uses `fetch-depth: 0` and read-only permissions, without
signing secrets. These tests do not compile the Samsung target or prove TV performance.

Session lifecycle: the core compiles production methods with real pthreads and a
controllable platform adapter. It covers concurrent duplicate stops, absent/failed
Open/Close callbacks, thread-creation failure, retained resource ownership, delayed
completion, stale workers/listeners and reopening. The `--strict` entry point is
retained; these safety contracts are now included in the default test.
For a separate race check, set `ML_LIFECYCLE_SANITIZER=thread`.
These fixtures do not emulate the full Samsung runtime or prove TV stability.

Smart Hub: the approved policy disconnects only the client on visibility loss;
the host game stays open and the user resumes manually from the library.
`app_lifecycle_test.js` covers repeated hide/show, cancelled menu/WoL work,
delayed launch/resume replies, stale connection messages and preserved launch
payloads. `input_focus_test.js` checks held-input release before disconnect;
blur alone does not stop a stream. Hardware suspension/EMSS still needs a TV test.

Extended native HTTP/RTP, browser layout/navigation and actual WGT signature/privacy
checks are coordinated by the maintainer's local tools, separately from public CI.
Browser/EMSS adapters are not a Samsung decoder or a physical controller.

Optional controller mapping: `controller_mapping_test.js` checks permutation
validation, persistence/failure, exact trigger bits, multi-controller snapshots
and the original function identity when OFF. The editor/test loop is menu-only;
sticks, rumble and native streaming algorithms are unchanged. Historical source
guards allow only the explicit integration points, not arbitrary input changes.

Optional audio telemetry: `audio_telemetry_test.js` compares Worklet/fallback
Float32 output and drift control with v3.4.3 across rates/channels and ON/OFF
transitions. OFF skips depth extrema; functional adaptation remains active.
Source contracts allow only collection gates, not audio/video retuning.

Gamepad publication: `gamepad_publication_test.js` compares exact shared words
with v3.4.3, counts atomic stores and checks sequence wrap, hotplug, stop/restart
and a contending reader worker. Only changed payload words are stored; initial
publication and stop still overwrite the full payload. Sampling, mapping,
notification and native seqlock behavior stay unchanged. This is not TV timing.

Overlay aggregation: `overlay_aggregation_test.js` compiles the production
collection prefix and both formatters with deterministic adapters and ASan/UBSan.
It compares messages/history with v3.4.3 across codecs, rates and independent
consumer transitions. Diagnostic-only collection skips display aggregation;
window cadence, diagnostic payloads and overlay reactivation remain unchanged.

Library selection: `library_selection_test.js` compares the complete selected-card
state with the prior implementation and counts writes/mutations. It covers
immediate focus persistence, restart, legacy/corrupt storage, quota failures,
multiple PCs, filters, launch and suspension. Compact focus is merged before
opening a PC and retired only after a successful full-preferences write.

Menu controller: `controller_menu_test.js` compares events, order and private
snapshots with the prior implementation, including hotplug, layout changes,
restart, legacy polling and synchronous/reentrant listeners. Stable layouts
reuse snapshot arrays/buttons; unchanged polls do not create a changes array.
Emitted payloads remain independent; menu events also identify their controller.
The 16 ms interval and all streaming and
rumble policy remain frozen; allocation counts are not physical TV measurements.

Menu navigation: `library_navigation_test.js` executes the production reader,
listener and navigation stack against v3.4.8 with a deterministic clock. It covers immediate
analog selection, jitter/hysteresis, digital repeat, direction reversal, multiple
controllers, cancellation and unchanged gameplay sources. Library, Settings, PC
selection and pairing dialogs share this state. View changes cancel held-input
repetition; the controller test captures raw input independently. Synthetic
timing is not physical controller-to-screen latency.

Controller test mode: `controller_test_mode_test.js` checks physical artwork
highlights, confirm/back isolation, a continuous three-second Circle/B hold,
release protection, hotplug and cleanup. `rumble_work_test.js` compares exact
actuator traces with v3.4.4 and counts shared reads for zero to four controllers;
only inactive-slot work changes. These checks do not measure TV latency or CPU.

For documentation-only changes, check content, links and templates; a TV test
or WGT rebuild is not required. For runtime changes, select the full suite and
focused native/browser checks appropriate to the affected behavior.

Video recovery: `video_recovery_test.js` compares the production RTP queue,
depacketizer and extracted submit/status code against v3.4.7 using synthetic
codec headers, a controlled clock and injected Samsung results. It checks
repeated rejected keyframes, deferred IDR requests without another submit,
500 ms spacing, wrap/zero, cancellation/restart and healthy payload/timestamp/
clock-read equivalence. ASan/UBSan and a negative control guard the fixture.
The idle retry uses the existing receive timeout; no video queue or worker is
added. These are recovery contracts, not measured FPS or TV latency gains.

Optional seeded stress is separate from the core runner. The existing JS fixtures
accept `ML_STARTUP_CASES`, `ML_RUMBLE_FRAMES`, `ML_AUDIO_SECONDS`,
`ML_LIFECYCLE_CYCLES` and `ML_STRESS_SEED`; defaults keep the normal core bounded.
`protocol-fuzz.cpp` is an optional ASan/UBSan driver for the real RTSP/SPS parsers,
not linked into the application. The maintainer's local coordinator builds it,
supplies bounded synthetic seeds, preserves failing inputs and runs TSan separately.
The reproduced duplicate-RTSP-header leak, truncated-header out-of-bounds read
and H.264 Exp-Golomb/array-bound failures are covered by defensive repairs and
regression tests. Valid SPS decoding preserves pixels, profile, level and references.
Fuzz success is bounded input evidence, not proof against every malformed stream.

## Local compilation and packaging

The release builds recorded for this fork used a two-stage local path.
The Tizen installer needs `nofile=1024:524288`: an older bundled JVM may otherwise
fail to allocate its descriptor table and leave the CLI uninstalled, producing
a misleading `tizen: not found` later.

Development recipes:

```bash
docker build -f build-tools/Dockerfile.buildonly -t moonlight-wasm-check .
docker build --ulimit nofile=1024:524288 \
  -f build-tools/Dockerfile.package -t moonlight-wgt .
```

Compilation alone validates neither packaging nor TV playback. The public root
Dockerfile remains an alternative recipe, but its complete end-to-end execution
has not been established by those two-stage builds:

```bash
docker build --ulimit nofile=1024:524288 -t moonlight-tizen .
```

### Signing identity

Generic Docker recipes can generate a **test certificate** when no persistent
author key is supplied. A test key is not the release identity and can prevent
installation over a previous version.

For release builds, preserve the existing author identity and application/package
IDs. Supply the private key separately through **local** BuildKit secret mounts,
not through the source tree, image layers, logs or a remote runner. The public
author certificate may be used for identity verification; it is not the private key.
Recipes using a persistent key also require its SIGNING_CERT_SHA256 identity pin.
Do not silently generate a replacement or re-sign an already published widget.

Extract the WGT from the packaging image with `docker create` and `docker cp`.
The path is `/home/moonlight/Moonlight-v<version>-samirmartins[-ForceGM].wgt`;
substitute the version in `res/config.xml` and omit `-ForceGM` for Normal.
Remove only the temporary container created for extraction.

## ForceGM

Both variants use the same code. ForceGM adds this panel request to `config.xml`:

```xml
<tizen:metadata key="http://samsung.com/tv/metadata/use.game.mode" value="true"/>
```

It is independent of the in-app decoder Game Mode switch (`kUltraLow`).
On the tested Tizen 9 TV, leave that switch **off**; ForceGM still requests panel
Game Mode. This does not establish identical behavior on every TV.

```bash
docker build --ulimit nofile=1024:524288 --build-arg FORCE_GAME_MODE=1 \
  -f build-tools/Dockerfile.package -t moonlight-wgt-forcegm .
```

The root recipe accepts the same argument. Normal/ForceGM share application/package
IDs; updating without losing settings also requires a compatible author identity
and installation/re-signing method.

## Widget checks

Export the expected **public** author certificate as DER and set WIDGET_VERSION
for the files being checked (3.4.0 is an example):

```bash
WIDGET_VERSION=3.4.0
python3 build-tools/verify-widgets.py \
  "Moonlight-v${WIDGET_VERSION}-samirmartins.wgt" \
  "Moonlight-v${WIDGET_VERSION}-samirmartins-ForceGM.wgt" \
  --author-cert /path/to/public-author.der
```

This checks version/IDs, public author identity, ForceGM metadata and variant
payload equality. It does not replace cryptographic signature/digest coverage
verification, privacy review or a TV installation test.

## Legacy release workflows

The stable/development packaging workflows remain manual and use the root recipe.
They require private signing input on a remote runner and produce drafts.
**They are not the maintainer's release-signing procedure. Do not upload the
maintainer's private certificate or configure GitHub Secrets with it.**
Use local signing and upload only audited WGTs/notes after explicit authorization.
A draft, tag or workflow dispatch is also an external action, not implicit approval.

## Recipe-specific notes

- `Dockerfile.package` retains an extra JDK from its validated recipe; the Tizen
  installer also bundles one. Removing it has not been tested.
- `__BUILD_TYPE__` / `__BUILD_COMMIT__` are substituted by CI. A local path that
  does not inject them may leave literal text in System Info; check the actual artifact.
