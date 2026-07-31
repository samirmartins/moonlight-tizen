# Moonlight Tizen

A fork of [brightcraft/moonlight-tizen](https://github.com/brightcraft/moonlight-tizen) — an open-source client for NVIDIA GameStream and [Sunshine](https://app.lizardbyte.dev/Sunshine/) that streams games from your PC to a Samsung Smart TV.

## About this fork

This fork addresses audio and video stuttering observed on a Samsung DU7700 running
[brightcraft's 1.13.1 build](https://github.com/brightcraft/moonlight-tizen). The audio
side had already been solved in [ruanformigoni's fork](https://github.com/ruanformigoni/moonlight-tizen),
which moves playback to the Web Audio API rather than the Tizen elementary media source;
that approach is ported here. The video side is the work added on top: the client no
longer imposes timing of its own, handing each frame to the platform as soon as it is
complete, on a timeline that follows the frame rate actually being delivered rather than
the one requested. It was developed with Claude Code.

> [!IMPORTANT]
> Testing has been limited to a single Samsung DU7700, where the result is smooth at
> 1080p, 1440p and 4K alike. Behaviour on other models is unknown.
>
> The project is offered as is. Regular maintenance is not planned, but pull requests
> and issues are welcome.

---

## Installation

Requires a Samsung TV running Tizen 5.5 or newer (2020 models onwards). Download a `.wgt` from the [releases](../../releases) and follow one of the [installation methods](https://github.com/brightcraft/moonlight-tizen/wiki/Installation-Guide) in the upstream wiki.

Two variants, identical except for one line of `config.xml` metadata:

| | |
|---|---|
| `Moonlight-…-samirmartins-ForceGM.wgt` | Asks the TV firmware to put the panel into Game Mode. **Recommended.** |
| `Moonlight-…-samirmartins.wgt` | The plain build, without that metadata. |

Both are published, following the convention of the upstream project. On the DU7700 the
ForceGM build performed better, and enabling the in-app *Game Mode* switch on the plain
build froze playback entirely.

**Install the ForceGM build and leave the in-app *Game Mode* switch off.** The two are
unrelated settings: the switch selects the decoder's ultra-low latency mode, while Game
Mode for the panel is requested from the firmware by the widget metadata. The switch
defaults to off and should stay there.

Installing one variant replaces the other and keeps your settings.

---

## Settings note

> [!IMPORTANT]
> **Leave *Allow gamepad rumble feedback* switched off.** It still costs added latency and
> a noticeable loss of smoothness while enabled, and that is not resolved. Successive
> releases have reduced what the feature costs, but not to zero, so the recommendation is
> unchanged: play with it off. The setting **defaults to off** for that reason.

*Audio jitter buffer* (default 50 ms) replaces the old *Audio synchronization* toggle. It
is the setpoint a rate servo holds, not a threshold above which audio is dropped. Raise it
if audio breaks up.

---

## Network note

The Ethernet port on some Samsung TVs is not gigabit. Where the bitrate required exceeds
what that link sustains - 4K in particular - Wi-Fi can outperform it, depending on
distance to the router/access point, wireless link quality and signal-to-noise ratio.

A wired connection remains preferable whenever the required bitrate stays comfortably
below its ceiling, such as in 1080p. Otherwise, Wi-Fi to a nearby wireless/access point with a cabled uplink is worth testing; on my DU7700 it proved the better of the two.

---

## Documentation

Installing the widget on a TV is covered by the upstream
[Installation Guide](https://github.com/brightcraft/moonlight-tizen/wiki/Installation-Guide),
which applies here unchanged.

---

## Building

```bash
docker build --ulimit nofile=1024:524288 -t moonlight-tizen .
```

> [!IMPORTANT]
> **The `--ulimit` is mandatory.** Without it the build fails at the packaging step with
> `/bin/sh: 1: tizen: not found`, which points at the wrong thing entirely: the Tizen Studio
> installer bundles its own JDK, that JVM aborts with `unable to allocate file descriptor
> table` because BuildKit runs steps with a very high `RLIMIT_NOFILE`, and the installer then
> **exits 0 having installed nothing**. The failure only surfaces fifteen steps later. No
> change to the `Dockerfile` is needed — just the flag.

Add `--build-arg FORCE_GAME_MODE=1` for the ForceGM variant. The widget is left in
`/home/moonlight/` inside the image, named after the version in `config.xml` and the variant:

```bash
CID=$(docker create moonlight-tizen)
docker cp "$CID:/home/moonlight/$(docker run --rm moonlight-tizen sh -c 'ls -1 /home/moonlight/*.wgt | xargs -n1 basename')" .
docker rm "$CID"
```

For a faster edit-compile loop that skips Tizen Studio entirely, see [`build-tools/README.md`](build-tools/README.md).


---

## License

`GNU General Public License v3.0`.

---

## Credits

Almost none of this application is my work. It exists because of:

- **[brightcraft](https://github.com/brightcraft/moonlight-tizen)** — for maintaining the repository this fork is based on, and for years of refactoring, bug fixing, UI/UX work, and new features that made it the most complete Moonlight client for Tizen. Consider [supporting his work](https://www.patreon.com/cw/BrightCraft/membership).
- **[ruanformigoni](https://github.com/ruanformigoni/moonlight-tizen)** — for working out that the Tizen elementary media source is what breaks the audio, and for the Web Audio backend that fixes it, which this fork ports.
- **[Moonlight Game Streaming Project](https://github.com/moonlight-stream)** — for the NVIDIA GameStream protocol implementation and the Chrome OS client.
- **[Samsung Developers Forum](https://github.com/SamsungDForum/moonlight-chrome)** — for the original WASM port to Tizen, including the video and audio pipelines built on the Tizen WASM Player.
- **[KyroFrCode](https://github.com/KyroFrCode/moonlight-chrome-tizen)** — for turning it into an installable application, and for the build method.
- **[OneLiberty](https://github.com/OneLiberty/moonlight-chrome-tizen)** — for codec selection, gamepad mouse emulation, Wake-on-LAN, and more.
- **[ToyPoodleGaming](https://github.com/toypoodlegaming/moonlight-chrome-tizen)** — for surround sound, performance statistics, and improved bitrate calculation.

And to **every contributor** to those projects.
