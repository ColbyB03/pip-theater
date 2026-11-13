"""Try the built plugin panel on a PC, with stand-ins for Steam's UI and for Decky.

    npm run build
    python tests/dev_panel.py          # then open http://localhost:8790/ in a Chromium-based browser
    ffmpeg -re -f lavfi -i testsrc2=size=590x1280:rate=30 -c:v libx264 -tune zerolatency -bf 0 -g 100000 \
           -f rtp "rtp://127.0.0.1:5004?pkt_size=1400"      # optional: a pretend phone

The page loads the real dist/index.js. Backend calls go to the real mirror service (without an
AirPlay receiver: "a phone is mirroring" is faked from "video arrived in the last three seconds").
The streaming-site engines need a Steam Deck and answer with an error here.
"""
import asyncio
import json
import logging
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import mirror as M  # noqa: E402

PORT = 8790
log = logging.getLogger("dev")


class Backend:
    """The subset of main.py's Plugin class the panel calls, without `decky`."""

    def __init__(self, mirror: M.Mirror) -> None:
        self.mirror = mirror
        self.settings = None

    async def get_settings(self):
        return self.settings

    async def save_settings(self, settings):
        self.settings = settings
        return True

    async def mirror_state(self):
        return self.mirror.state()

    async def mirror_configure(self, options):
        res = await self.mirror.configure(options)
        if self.mirror.options["receiverOn"]:
            self.mirror.rc_state, self.mirror.rc_message = "running", ""     # no real receiver here
        return res

    async def mirror_retry(self):
        return await self.mirror.retry()

    async def mirror_forget_phones(self):
        return await self.mirror.forget_phones()

    async def mirror_check(self):
        return await self.mirror.system_check()

    async def mirror_report(self, extra=""):
        return await self.mirror.save_report(extra)

    async def list_browsers(self):
        return []

    async def external_start(self, url, browser_id, rect):
        return {"ok": False, "error": "The external browser needs a Steam Deck (this is the PC preview)."}

    async def external_set_rect(self, rect):
        return None

    async def external_set_visible(self, visible):
        return None

    async def external_stop(self):
        return None

    async def cdp_targets(self):
        return []

    async def log(self, level, message):
        log.info("[ui %s] %s", level, message)


def serve(backend: Backend, loop: asyncio.AbstractEventLoop) -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, ctype, data):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            files = {"/": ("tests/harness.html", "text/html; charset=utf-8"),
                     "/dist/index.js": ("dist/index.js", "text/javascript; charset=utf-8")}
            hit = files.get(self.path.split("?")[0])
            if not hit:
                return self._send(404, "text/plain", b"not found")
            try:
                with open(os.path.join(ROOT, hit[0]), "rb") as fh:
                    self._send(200, hit[1], fh.read())
            except OSError as exc:
                self._send(500, "text/plain", str(exc).encode())

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                fn = getattr(backend, str(body.get("method")), None)
                if fn is None or str(body.get("method")).startswith("_"):
                    return self._send(404, "application/json", json.dumps({"error": "no such method"}).encode())
                fut = asyncio.run_coroutine_threadsafe(fn(*body.get("args", [])), loop)
                self._send(200, "application/json", json.dumps({"result": fut.result(180)}).encode())
            except Exception as exc:  # noqa: BLE001
                self._send(500, "application/json", json.dumps({"error": str(exc)}).encode())

    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    tmp = tempfile.mkdtemp(prefix="pip-theater-dev-")
    m = M.Mirror(plugin_dir=ROOT, settings_dir=os.path.join(tmp, "settings"), home=os.path.join(tmp, "home"),
                 user="dev", log=logging.getLogger("mirror"), version="dev")

    def session():
        live = bool(m.last_packet and time.time() - m.last_packet < 3)
        return {"connected": live, "mirroring": live}

    m.session_fn = session
    await m.start({"receiverOn": False})
    m.options["receiverOn"] = True
    m.rc_state = "running"       # pretend the receiver is up
    m.guard = lambda *a, **k: asyncio.sleep(0)   # nothing to keep alive here
    threading.Thread(target=serve, args=(Backend(m), asyncio.get_running_loop()), daemon=True).start()
    print("Panel preview: http://localhost:%d/   (video in: udp 127.0.0.1:%s)" % (PORT, m.rtp_port), flush=True)
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
