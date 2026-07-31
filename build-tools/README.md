# build-tools

Build tooling for this fork. The `Dockerfile` at the project root remains the official
process; what lives here exists for two reasons: to record a finding that blocks the
build outright, and to allow a fast iteration cycle.

---

## The `--ulimit` is mandatory

The root `Dockerfile` **fails** with a misleading message:

```
/bin/sh: 1: tizen: not found
```

The cause is neither the `tizen` CLI being off the PATH nor a missing JDK. The Tizen
Studio installer **bundles its own JDK** (under `~/.package-manager/jdk`), but that JVM
aborts during installation:

```
setting up jdk at /home/moonlight/.package-manager/jdk
library initialization failed - unable to allocate file descriptor table - out of memory
./installer.sh: line 19: 54 Aborted (core dumped) ".../jdk/bin/java" -jar installer.jar
```

The installer then **exits 0 having installed nothing**, which is why the next step is
the one that breaks, with a message pointing somewhere else entirely.

This is the classic behaviour of an older JVM in a container when `RLIMIT_NOFILE` is very
high: the JVM tries to allocate a descriptor table proportional to the limit. BuildKit
runs steps with an extremely high limit, while a plain `docker run` uses 1024, which is
why the same installer works there.

**Fix — pass the limit explicitly at build time:**

```bash
docker build --ulimit nofile=1024:524288 -t moonlight-tizen .
```

No change to the `Dockerfile` is required.

> Verified: the installer completes and produces `tizen-studio/tools/ide/bin/tizen`.
> A full end-to-end build with the root `Dockerfile` plus `--ulimit` has **not** been
> exercised; the widgets shipped so far came from the two-stage path described below.

---

## Two-stage fast cycle

The root `Dockerfile` downloads the Emscripten SDK (~1 GB) and Tizen Studio (~280 MB) in
the same layer chain, so any code change invalidates everything. Separating compilation
from packaging avoids that.

**1. Compile and link** (validates all the C/C++, no Tizen Studio involved):

```bash
docker build -f build-tools/Dockerfile.buildonly -t moonlight-wasm-check .
```

**2. Package and sign** (starts from the image above):

```bash
docker build --ulimit nofile=1024:524288 \
  -f build-tools/Dockerfile.package -t moonlight-wgt .
```

**3. Extract the `.wgt`:**

```bash
CID=$(docker create moonlight-wgt)
docker cp "$CID:/home/moonlight/$(docker run --rm moonlight-wgt sh -c 'ls -1 /home/moonlight/*.wgt | xargs -n1 basename')" .
docker rm "$CID"
```

The filename is assembled during the build from the version declared in `config.xml` and
the variant — `Moonlight-v<version>-samirmartins[-ForceGM].wgt` — which is why the recipe
discovers the name rather than hardcoding it.

While iterating on code, only step 1 needs to run: it is the one that catches compile and
link errors.

---

## The ForceGM variant

Upstream publishes two widgets per release, **built from the same code**. The only
difference is one line in `config.xml`:

```xml
<tizen:metadata key="http://samsung.com/tv/metadata/use.game.mode" value="true"/>
```

It asks the TV firmware to put the **panel** into Game Mode while the app runs. It lived
in `res/config.xml` until `ac6ba96` (Dec 2024), which removed it because it froze the app
on newer Tizen; since then it has been a separate download.

**Not to be confused with the in-app "Game Mode" switch**, which selects the EMSS
`kUltraLow` latency mode (`wasm/main.cpp`). They are independent, and it is the switch,
not the metadata, that breaks on Tizen 9.0. In this variant the switch must stay **off**:
the decoder then uses `kLow`, which is stable, and the panel gets Game Mode from the
metadata.

Building it needs only the `--build-arg` on step 2; everything else is identical and the
whole layer cache is reused:

```bash
docker build --ulimit nofile=1024:524288 --build-arg FORCE_GAME_MODE=1 \
  -f build-tools/Dockerfile.package -t moonlight-wgt-forcegm .
```

The same `--build-arg` works on the root `Dockerfile` if you prefer the official
single-step path.

Both widgets carry the **same** `tizen:application id` and `package`, as upstream does:
installing one replaces the other, and saved settings are preserved. Going back is just
installing the other `.wgt`.

---

## Notes

- The `openjdk-17-jdk-headless` installed in `Dockerfile.package` turned out to be
  **unnecessary** (the installer brings its own JDK). It was kept because the recipe was
  validated with it present; removing it should be safe in principle, but has not been
  tested.
- The packaging image creates a test certificate (profile `Moonlight`). Its author
  identity is not guaranteed to match earlier releases; use a persistent certificate for
  seamless upgrades across release builds.
- The `__BUILD_TYPE__` / `__BUILD_COMMIT__` placeholders in `wasm/platform/index.js` are
  substituted by the CI workflow, not by a local build. Locally they stay literal, which
  only affects the version string shown on the System Info screen.
