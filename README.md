# PiP Theater

A [Decky Loader](https://decky.xyz) plugin that plays Netflix, Disney+, YouTube, Twitch
and other streaming sites in a small picture-in-picture window **on top of your games**
in Steam Game Mode.

## Why another PiP plugin?

Other PiP plugins play video inside Steam's own built-in browser. That browser has no
**Widevine** DRM module, so Netflix, Disney+, Max, Prime Video, Hulu and similar
services refuse to play. No setting in those plugins can fix this.

PiP Theater has **two playback engines** and picks the right one automatically:

| Engine | Used for | How it works |
| --- | --- | --- |
| **Steam built-in** | YouTube, Twitch, Plex, Kick, any non-DRM site | Steam's own browser view, drawn above the game |
| **External browser (DRM)** | Netflix, Disney+, Max, Prime Video, Hulu, Paramount+, Peacock, Apple TV+, Crunchyroll, Spotify… | A real Chrome / Edge / Brave (Flatpak, includes Widevine) turned into a gamescope overlay above the game |

## Features

- Type any website, or use the **Quick launch** list of popular services
- **Bookmarks** for your favorite sites and shows (each remembers its engine)
- **Resize**: S / M / L / XL presets plus a fine size slider; 16:9, 21:9, 4:3 or square
- **Place it anywhere**: 9-point snap grid, horizontal/vertical sliders, nudge arrows, edge margin
- **Plays nicely with Steam menus**: moves out of the way of the Quick Access / Steam menu (or hides)
- Playback controls from the Quick Access menu: play/pause, ±10 s, volume, mute
  (Netflix seeking uses Netflix's own player API so it doesn't error out)
- **Hide** the picture while keeping the audio (listen-only mode)
- **Video fills window**: strips the website around the video so the PiP is all picture
- **Browse & control** page: full-screen view to log in, pick a profile and choose a show
  with the touchscreen, trackpad and on-screen keyboard
- **Resume after restart** (optional)
- Built-in check that tells you whether Steam's browser supports DRM on your SteamOS version

## Requirements

- Steam Deck (or another SteamOS / gamescope device) with Decky Loader
- For DRM sites: **Google Chrome**, **Microsoft Edge** or **Brave** installed from
  Discover in Desktop Mode (they are Flatpaks). Google Chrome is the default.

## Usage

1. Press **⋯** (Quick Access) → Decky (plug icon) → **PiP Theater**.
2. Pick a service from **Quick launch** or type a site and press **Watch**.
3. First time on a DRM site: tap **Browse & control** to log in and pick a show.
   The video area looks black in that mirror view; that's DRM protection and is expected.
   Tap **Done** and the video plays in the PiP above your game.
4. Adjust **Size & position** while the Quick Access menu is open; changes apply live.

The external browser uses its own profile
(`~/.var/app/<browser>/pip-theater-profile`), so you log in once there; it doesn't
touch your normal browser profile.

## Known limitations

- **DRM quality**: on Linux, Netflix and some other services stream Chrome at up to 720p.
  This is the services' limit, not the plugin's.
- **Performance overlay conflict**: gamescope draws only *one* external overlay. If the
  Steam performance overlay (MangoHud) is on, the DRM engine's picture may not appear.
  Turn the performance overlay off while watching.
- **Opacity** isn't adjustable: neither Steam's browser view nor gamescope overlays
  support translucent video.
- Both engines rely on undocumented Steam and gamescope internals, so a SteamOS update
  could break them. Check the plugin log first:
  `~/homebrew/logs/PiP Theater/`.

## Building

```bash
npm install
npm run package   # builds dist/ and writes out/pip-theater.zip
```

See [PUBLISHING.md](PUBLISHING.md) for installing it on your Deck and sharing it.

## License

BSD-3-Clause. See [LICENSE](LICENSE).
