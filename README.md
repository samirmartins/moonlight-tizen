# Moonlight Tizen

A fork of [brightcraft/moonlight-tizen](https://github.com/brightcraft/moonlight-tizen) — an open-source client for NVIDIA GameStream and [Sunshine](https://app.lizardbyte.dev/Sunshine/) that streams games from your PC to a Samsung Smart TV.

## About this fork

I was getting both audio and video stuttering streaming to my Samsung **DU7700** with [brightcraft's 1.13.1 build](https://github.com/brightcraft/moonlight-tizen). [ruanformigoni's fork](https://github.com/ruanformigoni/moonlight-tizen) had already fixed the audio, but the video stutter was still there (at least with my TV). I used Claude Code to help me work on both, and this fork is the result: audio goes through the Web Audio API instead of the Tizen elementary media source, and the video path stopped adding timing of its own — frames are handed to the platform the moment they are complete, on a timeline that follows the frame rate actually being delivered.

> [!IMPORTANT]
> **It works very well on my DU7700, at Full HD, 1440p and 4K alike — I found no problems at any of the three.** That is one TV, though. I have not tested it on any other.
>
> **This is provided as is. I cannot maintain it regularly, but pull requests and issues are welcome and encouraged.**

---

## Installation

Requires a Samsung TV running Tizen 5.5 or newer (2020 models onwards). Download a `.wgt` from the [releases](../../releases) and follow one of the [installation methods](https://github.com/brightcraft/moonlight-tizen/wiki/Installation-Guide) in the upstream wiki.

Two variants, identical except for one line of `config.xml` metadata:

| | |
|---|---|
| `Moonlight-…-samirmartins.wgt` | The normal build. |
| `Moonlight-…-samirmartins-ForceGM.wgt` | Asks the TV firmware to put the panel into Game Mode. Measured lower latency here. Behaviour varies by model and firmware. |

**Keep the in-app *Game Mode* switch off on both.** It is a different setting: it selects the decoder's ultra-low latency mode, which freezes playback on the first frame on some models. It defaults to off.

Installing one replaces the other and keeps your settings.

---

## Settings note

*Audio jitter buffer* (default 50 ms) replaces the old *Audio synchronization* toggle. It is the setpoint a rate servo holds, not a threshold above which audio is dropped. Raise it if audio breaks up.

Performance is noticeably better with *Allow gamepad rumble feedback* switched off. That is being looked into.

---

## Network note

The Ethernet port on some Samsung TVs is not gigabit. Depending on the resolution you stream at — 4K in particular — and on the distance to the router, the quality of the link and its signal-to-noise ratio, Wi-Fi can outperform the TV's own wired connection.

A wired connection is preferable whenever the bitrate you need stays comfortably below what that link can actually sustain. When it does not, Wi-Fi to a nearby access point with a cabled uplink is worth trying. On the DU7700 that turned out to be the better of the two.

---

## Documentation

Everything about using the app is in the upstream wiki, which applies here unchanged:
[Installation Guide](https://github.com/brightcraft/moonlight-tizen/wiki/Installation-Guide) ·
[Updating Guide](https://github.com/brightcraft/moonlight-tizen/wiki/Updating-Guide) ·
[FAQ](https://github.com/brightcraft/moonlight-tizen/wiki/Frequently-Asked-Questions) ·
[Known Issues & Limitations](https://github.com/brightcraft/moonlight-tizen/wiki/Known-Issues-&-Limitations)

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
