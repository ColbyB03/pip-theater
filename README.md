# PiP Theater

A [Decky Loader](https://decky.xyz) plugin that puts a small, movable picture-in-picture
window **on top of your games** in Steam Game Mode. The window can show:

- **Your phone's screen**: iPhone, iPad or Mac, through the built-in **Screen Mirroring**
  (AirPlay). Nothing to install on the phone; the AirPlay receiver ships with the plugin.
  The phone's sound plays from the Deck with its own volume slider.
- **Streaming sites played on the Deck itself**: Netflix, Disney+, YouTube, Twitch and
  more, including the DRM-protected ones.

## Netflix (and other protected apps): read this first

Netflix, Disney+, Prime Video and similar apps show a **black picture** whenever a phone
mirrors its screen. That is done by the phone (iOS refuses to mirror protected video), so
it happens on every AirPlay receiver, including an Apple TV, and no plugin can change it.

PiP Theater's answer is to play those services **on the Deck** in the same window: open the
**Streaming** tab, pick Netflix, log in once. It uses a real Chrome / Edge / Brave with
Widevine, shown above the game as an overlay. Phone mirroring keeps working next to it, and
you switch between the two from the Quick Access menu.

## Features

**Phone mirror**
- The window **opens by itself** when the phone starts mirroring and closes when it stops
- **Takes the phone's shape** (portrait or landscape), or **fills** a window of the shape you choose
- **Phone volume** slider that leaves game and system sound alone
- **Approved phones only** (optional): a new phone types a 4-digit PIN once; a notification
  shows the PIN when a phone asks. Or let anyone on your Wi-Fi mirror
- **Rename** the Deck as phones see it
- **Quality**: Sharp (1080p), Balanced (720p) or Battery saver (540p), optional **60 fps**,
  and a **low delay** mode
- **Recovers by itself** after sleep, Wi-Fi changes and receiver crashes
- Nothing in the window can be tapped by accident

**Streaming**
- Type any website, or use the **Quick launch** list; **bookmarks** for your favorites
- Two engines, picked automatically: Steam's built-in browser for YouTube, Twitch, Plex...,
  and an external browser for DRM sites
- Play/pause, ±10 s, volume, mute, **hide** (listen-only) from the Quick Access menu
- **Video fills window**: hides the website around the video
- **Browse & control**: a full-screen page to log in and pick a show with the touchscreen
- Optional **resume after restart**

**Window** (shared by both)
- **Size**: S / M / L / XL presets plus a fine slider
- **Position**: 9-point snap grid, horizontal and vertical sliders, nudge arrows, edge margin
- **Shape**: 16:9, 21:9, 4:3 or square
- When Steam menus open: **move out of the way**, **hide**, or stay

**Help**
- **Check setup** tests every part and shows what is wrong
- **Save problem report** writes a text file to Downloads (never contains your PIN)

## Install

You need [Decky Loader](https://decky.xyz) on your Steam Deck.

1. Quick Access menu (**...**) > Decky (plug icon) > gear icon > turn on **Developer mode**.
2. **Developer** > **Install Plugin from URL**, and enter:

   ```
   https://github.com/ColbyB03/pip-theater/releases/latest/download/pip-theater.zip
   ```

Or download `pip-theater.zip` from the [Releases](../../releases) page and use
**Install Plugin from ZIP File**.

For Netflix and other DRM sites, also install **Google Chrome** (or Microsoft Edge / Brave)
from **Discover** in Desktop Mode. You don't need to add it to Steam.

## Use

**Mirror your phone**
1. Phone and Deck on the same Wi-Fi.
2. On the phone: Control Center > **Screen Mirroring** > **Steam Deck**.
3. The window opens over your game. Adjust it under **...** > Decky > **PiP Theater**.

**Watch Netflix (or any site)**
1. **...** > Decky > **PiP Theater** > **Streaming**.
2. Pick a service from **Quick launch**, or type a site and press **Watch**.
3. First time on a DRM site: **Browse & control** to log in and pick a show. The video area
   looks black in that control view (DRM protection); it plays normally in the window.

## Limits

- Mirroring has about 0.1-0.3 s of delay: fine for watching, not for playing phone games
  through the Deck.
- Same Wi-Fi needed. Networks with "client isolation" (common on guest and hotel Wi-Fi)
  block AirPlay discovery.
- A phone sends a complete picture only when mirroring starts, then only the changes. The
  plugin keeps decoding in the background so the window can be hidden and shown freely; if
  the picture is ever lost, the window says so, and stopping and restarting Screen Mirroring
  on the phone brings it back.
- Android phones don't have AirPlay, so they can't mirror with this plugin.
- DRM sites stream at up to 720p in Chrome on Linux. That is the services' limit.
- The external (DRM) engine uses gamescope's single overlay slot. If the Steam performance
  overlay is on, the picture may not appear: turn the performance overlay off while watching.
- The window is not translucent: neither Steam's browser view nor gamescope overlays support it.
- The plugin relies on undocumented Steam and gamescope internals, so a SteamOS update can
  break parts of it. **Help > Check setup** shows which.

## How it works

- **Phone mirror**: the plugin runs [UxPlay](https://github.com/FDH2/UxPlay), an open-source
  AirPlay receiver built for SteamOS (it uses SteamOS's own GStreamer and brings only an AAC
  decoder and an H.264 parser, about 3.5 MB). UxPlay hands the phone's H.264 video to the
  plugin's backend, which serves it to a page in a Steam browser view drawn over the game;
  the page decodes it with WebCodecs. The sound goes straight to the Deck's audio as its own
  stream.
- **Streaming, non-DRM**: a Steam browser view over the game.
- **Streaming, DRM**: a Flatpak Chrome / Edge / Brave with its own profile
  (`~/.var/app/<browser>/pip-theater-profile`), re-parented into a gamescope overlay window
  and controlled over the DevTools protocol.
- Backend: Python standard library only.

## Development

```bash
npm install
```

```bash
npm run package
```

`npm run package` builds `dist/` and writes `out/pip-theater.zip`. The AirPlay receiver is
built separately by `receiver/build-uxplay.sh` (Debian 12 container); the release workflow
in `.github/workflows/release.yml` does both and publishes the ZIP when you push a `v*` tag.

Without a Steam Deck:

- `python -m unittest discover -s tests` runs the backend tests.
- `python tests/dev_panel.py` serves the real built panel with stand-ins for Steam and Decky
  at <http://localhost:8790/>; the comment at the top of that file shows how to feed it a
  test video with ffmpeg in place of a phone.

See [PUBLISHING.md](PUBLISHING.md) for releasing and sharing the plugin.

## Credits and licenses

PiP Theater's own code is BSD 3-Clause ([LICENSE](LICENSE)). The phone-mirroring design
follows [decky-screen-mirror](https://github.com/otisabiburada/decky-screen-mirror) (BSD-3),
and the browser-view approach follows [decky-pip](https://github.com/rossimo/decky-pip) (BSD-3).

Released ZIPs contain a separate program, the AirPlay receiver: **UxPlay** (GPL-3.0),
**FFmpeg** (LGPL-2.1+, AAC/ALAC decoders only), **GStreamer** plugins (LGPL-2.1+) and
**libplist** (LGPL-2.1+). Versions, licenses and sources are listed in
[receiver/THIRD_PARTY.md](receiver/THIRD_PARTY.md), and each GitHub release carries the
complete source archives.

Not affiliated with, endorsed by or sponsored by Apple, Netflix or Valve. AirPlay, iPhone,
iPad and Mac are trademarks of Apple Inc.
