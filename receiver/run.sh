#!/bin/sh
# Starts the bundled AirPlay receiver (UxPlay).
# The bundled GStreamer plugins are added only where the system lacks them (the system's own,
# newer ones win), and the receiver keeps a private plugin registry so it can never affect
# other programs.
D="$(cd "$(dirname "$0")" && pwd)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/pip-theater"
mkdir -p "$CACHE"
P=""
gst-inspect-1.0 avdec_aac >/dev/null 2>&1 || P="$D/gst/libav"
gst-inspect-1.0 h264parse >/dev/null 2>&1 || P="${P:+$P:}$D/gst/videoparsers"
export GST_PLUGIN_PATH="$P${GST_PLUGIN_PATH:+:$GST_PLUGIN_PATH}"
export GST_REGISTRY="$CACHE/gst-registry-$(cksum < "$D/VERSION" | cut -d' ' -f1).bin"
echo "pip-theater: bundled GStreamer plugins in use: ${P:-none}"
exec "$D/uxplay" "$@"
