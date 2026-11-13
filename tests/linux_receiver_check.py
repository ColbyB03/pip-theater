"""Starts the real mirror service with the real bundled AirPlay receiver on Linux and reports
whether the receiver comes up with the options the plugin uses.

Meant for a SteamOS-like container (Arch Linux with only GStreamer core/base/good), with the
repository mounted at /plugin and bin/uxplay-steamos in place:

    docker run --rm -v "$PWD:/plugin:ro" archlinux:latest bash -c \
      "pacman -Sy --noconfirm --needed python gstreamer gst-plugins-base gst-plugins-good >/dev/null \
       && python /plugin/tests/linux_receiver_check.py"

Exit code 0 means the receiver started and stayed up for every option set.
"""
import asyncio
import json
import logging
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import mirror as M  # noqa: E402

OPTION_SETS = [
    {"receiverOn": True},
    {"receiverOn": True, "name": "Test Deck", "access": "pin", "quality": "sharp", "fps60": True, "lowDelay": True},
    {"receiverOn": True, "quality": "saver"},
]


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    tmp = tempfile.mkdtemp(prefix="pip-theater-check-")
    failures = 0
    m = M.Mirror(plugin_dir=ROOT, settings_dir=os.path.join(tmp, "settings"), home=os.path.join(tmp, "home"),
                 user="deck", log=logging.getLogger("mirror"), version="check")
    os.makedirs(os.path.join(tmp, "home"), exist_ok=True)
    await m.start({"receiverOn": False})
    for opts in OPTION_SETS:
        await m.configure(dict(opts))
        await asyncio.sleep(6)
        st = m.state()
        ok = st["receiver"]["state"] == "running" and m.rc_proc is not None and m.rc_proc.returncode is None
        print("\n=== options %s -> %s %s" % (json.dumps(opts), "OK" if ok else "FAILED", st["receiver"]["message"]))
        print("\n".join("   " + ln for ln in m.rc_output[-12:]))
        failures += 0 if ok else 1
    check = await m.system_check()
    print("\n=== system check: ready=%s %s" % (check["ready"], json.dumps(check["elements"])))
    failures += 0 if check["ready"] else 1
    await m.configure({"receiverOn": False})
    await m.stop()
    print("\nRESULT: %s" % ("all good" if not failures else "%d problem(s)" % failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
