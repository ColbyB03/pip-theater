#!/bin/bash
# Builds a portable UxPlay (AirPlay receiver) bundle for SteamOS (x86_64).
#
# Run inside a Debian 12 container (its older glibc means the result also runs on newer systems):
#   docker run --rm -e UXPLAY_REF="$(cat receiver/UXPLAY_REF)" -v "$PWD/receiver:/work" \
#       debian:bookworm bash /work/build-uxplay.sh
# Output: receiver/out/uxplay-steamos/ (copy it to bin/uxplay-steamos/ before packaging) and
#         receiver/out/third-party-sources.tar (the exact sources, to publish next to the plugin).
#
# The bundle uses SteamOS's own GStreamer at run time and brings only what SteamOS lacks:
# libplist, a tiny FFmpeg (AAC + ALAC audio decoders only) with GStreamer's libav plugin, and
# GStreamer's H.264 parser. Based on the build script of decky-screen-mirror (BSD-3-Clause).
set -euxo pipefail
UXPLAY_REF="${UXPLAY_REF:?set UXPLAY_REF to a UxPlay commit}"
FFMPEG_VERSION=5.1.6
GST_LIBAV_VERSION=1.22.0
OUT=/work/out; SRC=/src; B=/opt/av; SOURCES="$OUT/sources"
rm -rf "$OUT" && mkdir -p "$OUT" "$SRC" "$SOURCES"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends build-essential cmake pkg-config git ca-certificates curl xz-utils \
  libssl-dev libplist-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libdbus-1-dev \
  meson ninja-build python3 patchelf file dpkg-dev >/dev/null

# 1. UxPlay
git clone -q https://github.com/FDH2/UxPlay "$SRC/UxPlay"
git -C "$SRC/UxPlay" checkout -q "$UXPLAY_REF"
git -C "$SRC/UxPlay" archive --format=tar.gz --prefix="UxPlay-$UXPLAY_REF/" -o "$SOURCES/UxPlay-$UXPLAY_REF.tar.gz" HEAD
cmake -S "$SRC/UxPlay" -B "$SRC/ux" -DCMAKE_BUILD_TYPE=Release -DNO_MARCH_NATIVE=ON -DNO_X11_DEPS=ON >/dev/null
make -C "$SRC/ux" -j"$(nproc)" >/dev/null

# 2. a tiny FFmpeg: only the AAC (incl. AAC-ELD) and ALAC audio decoders
curl -sSfL -o "$SOURCES/ffmpeg-$FFMPEG_VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
tar -xJf "$SOURCES/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$SRC"
cd "$SRC/ffmpeg-$FFMPEG_VERSION"
./configure --prefix="$B" --enable-shared --disable-static --disable-programs --disable-doc --disable-everything \
  --enable-decoder=aac,aac_latm,alac --disable-avdevice --disable-swscale --disable-postproc \
  --disable-network --disable-autodetect --disable-x86asm --enable-pic >/dev/null
make -j"$(nproc)" >/dev/null && make install >/dev/null

# 3. GStreamer's libav plugin (avdec_*), for Debian 12's GStreamer 1.22 (it loads in newer GStreamer too)
curl -sSfL -o "$SOURCES/gst-libav-$GST_LIBAV_VERSION.tar.xz" \
  "https://gstreamer.freedesktop.org/src/gst-libav/gst-libav-$GST_LIBAV_VERSION.tar.xz"
tar -xJf "$SOURCES/gst-libav-$GST_LIBAV_VERSION.tar.xz" -C "$SRC"
cd "$SRC/gst-libav-$GST_LIBAV_VERSION"
PKG_CONFIG_PATH="$B/lib/pkgconfig" meson setup build --buildtype=release -Ddoc=disabled -Dtests=disabled >/dev/null
ninja -C build >/dev/null

# 4. the bundle
D="$OUT/uxplay-steamos"; mkdir -p "$D/lib" "$D/gst/libav" "$D/gst/videoparsers" "$D/licenses"
cp "$SRC/ux/uxplay" "$D/"
cp -L "$(ldconfig -p | awk '/libplist-2.0.so.3 /{print $NF; exit}')" "$D/lib/"
for l in avcodec avformat avfilter avutil swresample; do
  cp -L "$B"/lib/lib$l.so.[0-9][0-9] "$D/lib/" 2>/dev/null || cp -L "$B"/lib/lib$l.so.[0-9] "$D/lib/"
done
cp build/ext/libav/libgstlibav.so "$D/gst/libav/"
# UxPlay also needs GStreamer's "videoparsersbad" plugin (plugins-bad), which SteamOS lacks:
# take Debian 12's build of it and the one library it needs.
apt-get install -y -qq --no-install-recommends gstreamer1.0-plugins-bad >/dev/null
GL=/usr/lib/x86_64-linux-gnu
cp "$GL/gstreamer-1.0/libgstvideoparsersbad.so" "$D/gst/videoparsers/"
cp -L "$GL/libgstcodecparsers-1.0.so.0" "$D/lib/"
patchelf --set-rpath '$ORIGIN/../../lib' "$D/gst/videoparsers/libgstvideoparsersbad.so"
patchelf --set-rpath '$ORIGIN/lib' "$D/uxplay"
patchelf --set-rpath '$ORIGIN/../../lib' "$D/gst/libav/libgstlibav.so"
for f in "$D"/lib/*.so*; do patchelf --set-rpath '$ORIGIN' "$f"; done
strip --strip-unneeded "$D/uxplay" "$D"/lib/*.so* "$D"/gst/*/*.so
cp /work/run.sh "$D/run.sh" && chmod +x "$D/run.sh"
cp /work/THIRD_PARTY.md "$D/THIRD_PARTY.md"
cp "$SRC/UxPlay/LICENSE" "$D/licenses/UxPlay-LICENSE"
cp "$SRC/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$D/licenses/FFmpeg-COPYING.LGPLv2.1"
cp "$SRC/gst-libav-$GST_LIBAV_VERSION/COPYING" "$D/licenses/gst-libav-COPYING"
cp /usr/share/doc/gstreamer1.0-plugins-bad/copyright "$D/licenses/gst-plugins-bad-copyright" || true
cp /usr/share/doc/libplist3/copyright "$D/licenses/libplist-copyright" || true
{
  echo "uxplay $UXPLAY_REF, ffmpeg $FFMPEG_VERSION (aac, alac), gst-libav $GST_LIBAV_VERSION, gst videoparsersbad $(dpkg-query -W -f='${Version}' gstreamer1.0-plugins-bad), libplist $(dpkg-query -W -f='${Version}' libplist3), built on Debian 12 $(date -u +%F)"
  echo "layout 2: gst/libav and gst/videoparsers are added only where the system lacks them; private registry"
} > "$D/VERSION"

# 5. the exact sources of everything in the bundle, to publish next to the plugin
cp /work/build-uxplay.sh /work/run.sh /work/THIRD_PARTY.md "$SOURCES/"
(
  set +e   # Debian's source packages are a convenience copy; the upstream links are in THIRD_PARTY.md
  sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources
  apt-get update -qq && cd "$SOURCES" && apt-get source -qq --download-only gst-plugins-bad1.0 libplist
  true
)
tar -C "$OUT" -cf "$OUT/third-party-sources.tar" sources && rm -rf "$SOURCES"

ls -la "$OUT" "$D" "$D/lib" "$D/gst"/*
file "$D/uxplay"
objdump -T "$D/uxplay" "$D"/lib/*.so* "$D"/gst/*/*.so | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1
