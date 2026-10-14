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
The current comparisons require tags `v3.3.8`, `v3.3.10` and `v3.4.0`;
use a full checkout. CI uses `fetch-depth: 0` and read-only permissions, without
signing secrets. These tests do not compile the Samsung target or prove TV performance.

Session lifecycle: the default core exercises ordered/repeated stops and deferred
callbacks using production methods with recording adapters. Run
`node wasm/session_lifecycle_test.js --strict` for the missing-close-callback and
duplicate-stop and stale-worker safety contracts. These currently fail: teardown waits
indefinitely without its callback; duplicate stop creates two workers, and a controlled
ordering lets the orphaned worker affect the reopened session. Do not treat them
as passing or fix the player implicitly during test maintenance.

Extended native HTTP/RTP, browser layout/navigation and actual WGT signature/privacy
checks are coordinated by the maintainer's local tools, separately from public CI.
Browser/EMSS adapters are not a Samsung decoder or a physical controller.

For documentation-only changes, check content, links and templates; a TV test
or WGT rebuild is not required. For runtime changes, select the full suite and
focused native/browser checks appropriate to the affected behavior.

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
