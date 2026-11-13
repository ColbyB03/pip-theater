"""Run the mirror service on a PC, without a Steam Deck or an AirPlay receiver, to try the PiP page.

    python tests/dev_mirror.py
    ffmpeg -re -f lavfi -i testsrc2=size=590x1280:rate=30 -c:v libx264 -tune zerolatency -bf 0 -g 100000 \
           -f rtp "rtp://127.0.0.1:5004?pkt_size=1400"

Then open the printed URL in a Chromium-based browser. "A phone is mirroring" is faked from
"video arrived in the last three seconds". The state is printed as JSON every two seconds.
"""
import asyncio
import json
import logging
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import mirror as M  # noqa: E402


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    tmp = tempfile.mkdtemp(prefix="pip-theater-dev-")
    m = M.Mirror(plugin_dir=ROOT, settings_dir=os.path.join(tmp, "settings"), home=os.path.join(tmp, "home"),
                 user="dev", log=logging.getLogger("mirror"), version="dev")

    def session():
        live = bool(m.last_packet and time.time() - m.last_packet < 3)
        return {"connected": live, "mirroring": live}

    m.session_fn = session
    await m.start({"receiverOn": False, "fill": "--fill" in sys.argv})
    m.rc_state = "running"      # pretend the receiver is up, so the session is polled
    st = m.state()
    print("PLAYER_URL " + st["player_url"], flush=True)
    print("RTP_PORT %s" % st["rtp_port"], flush=True)
    while True:
        await asyncio.sleep(2)
        s = m.state()
        print("STATE " + json.dumps({k: s[k] for k in ("receiving", "session", "frames", "lost", "viewers",
                                                        "picture_lost", "report")}), flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
