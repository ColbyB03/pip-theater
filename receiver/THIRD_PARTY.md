# Third-party software in the AirPlay receiver bundle

`bin/uxplay-steamos/` in a released PiP Theater ZIP is a build of the AirPlay receiver the
plugin starts for phone mirroring. It is a separate program; the plugin's own code
(BSD 3-Clause) is not part of it and only talks to it over local network sockets.

| File | Software | License | Source |
|---|---|---|---|
| `uxplay` | [UxPlay](https://github.com/FDH2/UxPlay), AirPlay mirror/audio receiver | GPL-3.0 (`licenses/UxPlay-LICENSE`) | the commit named in `VERSION` (and in `receiver/UXPLAY_REF` in the plugin's repository) |
| `lib/libav*.so*`, `lib/libswresample.so*` | FFmpeg 5.1.6, only the AAC and ALAC audio decoders enabled | LGPL-2.1+ (`licenses/FFmpeg-COPYING.LGPLv2.1`) | https://ffmpeg.org/releases/ffmpeg-5.1.6.tar.xz |
| `gst/libav/libgstlibav.so` | GStreamer libav plugin 1.22.0 | LGPL-2.1+ (`licenses/gst-libav-COPYING`) | https://gstreamer.freedesktop.org/src/gst-libav/gst-libav-1.22.0.tar.xz |
| `gst/videoparsers/libgstvideoparsersbad.so`, `lib/libgstcodecparsers-1.0.so.0` | GStreamer plugins-bad 1.22 (Debian 12 package `gstreamer1.0-plugins-bad`) | LGPL-2.1+ (`licenses/gst-plugins-bad-copyright`) | https://gstreamer.freedesktop.org/src/gst-plugins-bad/gst-plugins-bad-1.22.0.tar.xz, Debian source package `gst-plugins-bad1.0` |
| `lib/libplist-2.0.so.3` | libplist 2.2.0 (Debian 12 package `libplist3`) | LGPL-2.1+ (`licenses/libplist-copyright`) | https://github.com/libimobiledevice/libplist/tree/2.2.0, Debian source package `libplist` |

**How it is built:** `receiver/build-uxplay.sh`, run in a `debian:bookworm` (x86_64) container by
the release workflow (`.github/workflows/release.yml`). No source changes are made to any of
these projects. The exact versions of a given build are in its `VERSION` file.

**Complete sources:** every GitHub release of PiP Theater carries an asset
`third-party-sources.tar` with the sources that build used (UxPlay at the exact commit,
FFmpeg, gst-libav, the Debian source packages of gst-plugins-bad1.0 and libplist where
available) plus the build script.

AirPlay, iPhone, iPad and Mac are trademarks of Apple Inc. PiP Theater is not affiliated with,
endorsed by or sponsored by Apple.
