<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/vibelight-logo.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/vibelight-logo-light.png">
    <img src="docs/images/vibelight-logo-light.png" alt="VibeLight-Tizen logo" width="320">
  </picture>
</p>

**VibeLight-Tizen** is an independently maintained, vibe-coded **fork of Moonlight Tizen** for Samsung Smart TVs, based on [BrightCraft's client](https://github.com/brightcraft/moonlight-tizen).

Stream PC games through [Sunshine](https://app.lizardbyte.dev/Sunshine/) or NVIDIA GameStream. The goal: keep improving VibeLight on Tizen OS toward a **console-like experience**, with **smoother gameplay and low latency**, without sacrificing image quality.

---

## Interface

![VibeLight interface: Wake PC, settings, Resume library, Add Host and controller testing](docs/images/interface.gif)

Simulated UI preview · [Image credits and licenses](docs/images/ATTRIBUTION.md).

---

## Installation and quick start

You need a Samsung TV running **Tizen 5.5 or newer** and a PC running Sunshine.
Keep the TV, PC and installation device on the same local network.

Choose the build that suits your TV:

- **Normal:** does not request TV panel Game Mode.
- **ForceGM:** requests TV panel Game Mode; behavior depends on the TV and firmware.

The in-app *Game Mode* switch is separate; see the FAQ below.

1. **Download VibeLight.** Get a `.wgt` from the
   [latest release](https://github.com/samirmartins/vibelight-tizen/releases/latest).
2. **Install on the TV.** Enable the TV's Developer Mode and install the downloaded
   widget with Apps2Samsung, following the
   [Installation Guide](INSTALLATION.md#apps2samsung-recommended).
3. **Set up Sunshine on the PC.** Follow Sunshine's
   [Getting Started guide](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2getting__started.html),
   open its web interface, and add your games under **Applications**.
   You can use **Desktop** for the first connection. Keep Sunshine running.
4. **Add and pair the PC.** Open VibeLight on the TV and select your PC from **PCs**.
   If it is not listed, choose **Add Host** and enter the PC's local IP address.
   Enter the PIN shown on the TV in Sunshine's **PIN** page on the PC to complete pairing.
5. **Start playing.** Connect a gamepad to the TV, select a game or **Desktop**
   in the library, and choose **Play**. Use **Resume** to reconnect to an
   application that is already running.

---

## What VibeLight offers

- **Video:** hardware decoding, H.264/HEVC/AV1 (depending on TV hardware), TV-aware timing and stream recovery.
- **Audio:** AudioWorklet where supported, with adaptive buffering and a compatibility fallback.
- **Controls:** rumble, saved button remapping and visual button testing.
- **Library:** controller-first navigation, favorites, recent games, cached covers,
  Play, Resume and Wake PC.
- **Diagnostics:** optional performance overlay and a local session report.

---

## Defaults and behavior

- **Video defaults:** H.264, 1920×1080 at 60 FPS, 30 Mbps.
- **Rumble:** on by default.
- **Audio buffer:** adaptive, with a default 100 ms ceiling—not fixed latency.
- **Smart Hub:** disconnects the client; the game stays available for Resume.
- **Session diagnosis:** off at startup; stores only the latest report locally.

---

## FAQ

### How do ForceGM and the in-app Game Mode differ?

ForceGM requests Game Mode for the TV panel. The in-app switch selects the
decoder's Ultra Low Latency mode, which can freeze video on some models.
**When using ForceGM, leave VibeLight's in-app Game Mode switch OFF.**

### How do I wake the PC?

Enable Wake-on-LAN on the PC and network adapter, then pair while the PC is online.
Select **Wake PC**; enter its LAN MAC address if prompted. When Sunshine is ready,
press **Play**. If the status is outdated, use **Reload VibeLight**. Play remains
available regardless of the displayed status. The MAC stays in TV storage and
LAN wake packets.

### What if the PC does not appear or pairing fails?

Follow the manual **Add Host** and PIN steps in [Installation and quick start](#installation-and-quick-start).
If the pairing dialog says the PC is busy, stop its running streaming application
before retrying. For other errors, check Sunshine's **Troubleshooting** logs.

### Can I update without losing settings?

Install over the existing app using the same author certificate or signing profile,
without uninstalling it. A clean reinstall removes settings and pairing.
See [Updates](INSTALLATION.md#updates) for details and installer precautions.

---

## Documentation and feedback

- [Changelog](CHANGELOG.md)
- [Installation Guide](INSTALLATION.md)
- [Issues](https://github.com/samirmartins/vibelight-tizen/issues)
- [Contributing](.github/CONTRIBUTING.md)
- [Build and signing guide](build-tools/README.md)
- [License: GPL-3.0](LICENSE)

---

## Credits

- **[BrightCraft](https://github.com/brightcraft/moonlight-tizen)** — fork foundation.
- **[ruanformigoni](https://github.com/ruanformigoni/moonlight-tizen)** — initial Web Audio foundation.
- **[Moonlight Game Streaming Project](https://github.com/moonlight-stream)** — core streaming libraries.
- **Earlier upstream work:** [Samsung Developers Forum](https://github.com/SamsungDForum/moonlight-chrome), [KyroFrCode](https://github.com/KyroFrCode/moonlight-chrome-tizen), [OneLiberty](https://github.com/OneLiberty/moonlight-chrome-tizen) and [ToyPoodleGaming](https://github.com/toypoodlegaming/moonlight-chrome-tizen).
- **Claude Code and OpenAI Codex** — development assistance.

And to **every contributor** to those projects.
