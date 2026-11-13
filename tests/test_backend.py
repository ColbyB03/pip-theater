"""Backend tests. Run from the repository root:  python -m unittest discover -s tests -v

They need no Steam Deck and no `decky` module: backend/mirror.py and backend/h264.py are plain Python.
"""
import asyncio
import json
import logging
import os
import socket
import struct
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import mirror as M  # noqa: E402
from h264 import HEADER, HEADER_SIZE, H264Depacketizer, pack_frame  # noqa: E402

SPS = bytes([0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9])
PPS = bytes([0x68, 0xEB, 0xE3, 0xCB])
IDR = bytes([0x65]) + bytes(range(256)) * 20       # 5 kB key-frame slice
P1 = bytes([0x41]) + b"\x11" * 300
P2 = bytes([0x41]) + b"\x22" * 3000


class Rtp:
    """Minimal RTP H.264 packetizer (single NAL, STAP-A, FU-A), independent of the code under test."""

    def __init__(self, ssrc=0x1234, seq=100, mtu=1400):
        self.ssrc, self.seq, self.mtu = ssrc, seq, mtu

    def _pkt(self, payload, ts, marker):
        hdr = struct.pack(">BBHII", 0x80, 96 | (0x80 if marker else 0), self.seq & 0xFFFF, ts, self.ssrc)
        self.seq += 1
        return hdr + payload

    def frame(self, nals, ts, stap=False):
        out = []
        if stap:
            body = b"\x18" + b"".join(struct.pack(">H", len(n)) + n for n in nals)
            return [self._pkt(body, ts, True)]
        for i, nal in enumerate(nals):
            last_nal = i == len(nals) - 1
            if len(nal) <= self.mtu:
                out.append(self._pkt(nal, ts, last_nal))
                continue
            ind, typ, data = nal[0] & 0xE0, nal[0] & 0x1F, nal[1:]
            chunks = [data[j:j + self.mtu] for j in range(0, len(data), self.mtu)]
            for j, c in enumerate(chunks):
                fu = typ | (0x80 if j == 0 else 0) | (0x40 if j == len(chunks) - 1 else 0)
                out.append(self._pkt(bytes([ind | 28, fu]) + c, ts, last_nal and j == len(chunks) - 1))
        return out


def annexb(*nals):
    return b"".join(b"\x00\x00\x00\x01" + n for n in nals)


def feed_all(d, packets):
    frames = []
    for p in packets:
        frames += d.feed(p)
    return frames


class DepacketizerTests(unittest.TestCase):
    def test_key_frame_then_deltas(self):
        d, r = H264Depacketizer(), Rtp()
        frames = feed_all(d, r.frame([SPS, PPS, IDR], 9000) + r.frame([P1], 12000) + r.frame([P2], 15000))
        self.assertEqual([(f[1], f[2]) for f in frames], [(9000, True), (12000, False), (15000, False)])
        self.assertEqual(frames[0][0], annexb(SPS, PPS, IDR))
        self.assertEqual(frames[2][0], annexb(P2))
        self.assertEqual(d.lost, 0)

    def test_nothing_before_first_key_frame(self):
        d, r = H264Depacketizer(), Rtp()
        self.assertEqual(feed_all(d, r.frame([P1], 1) + r.frame([P2], 2)), [])
        self.assertEqual(len(feed_all(d, r.frame([SPS, PPS, IDR], 3))), 1)

    def test_stap_a(self):
        d, r = H264Depacketizer(), Rtp()
        frames = feed_all(d, r.frame([SPS, PPS], 5, stap=True)[:0] + r.frame([SPS, PPS, bytes([0x65, 1, 2, 3])], 5, stap=True))
        self.assertEqual(frames[0][0], annexb(SPS, PPS, bytes([0x65, 1, 2, 3])))
        self.assertTrue(frames[0][2])

    def test_parameter_sets_added_to_bare_key_frame(self):
        d, r = H264Depacketizer(), Rtp()
        feed_all(d, r.frame([SPS, PPS, IDR], 1))
        frames = feed_all(d, r.frame([IDR], 2))
        self.assertEqual(frames[0][0], annexb(SPS, PPS, IDR))

    def test_lost_packet_drops_only_that_frame(self):
        d, r = H264Depacketizer(), Rtp()
        feed_all(d, r.frame([SPS, PPS, IDR], 1))
        broken = r.frame([P2], 2)
        del broken[1]                       # lose the middle of a fragmented frame
        frames = feed_all(d, broken + r.frame([P1], 3) + r.frame([P1], 4))
        self.assertEqual([f[1] for f in frames], [3, 4])
        self.assertEqual(d.lost, 1)
        self.assertEqual(d.dropped_frames, 1)

    def test_lost_marker_packet(self):
        d, r = H264Depacketizer(), Rtp()
        feed_all(d, r.frame([SPS, PPS, IDR], 1))
        broken = r.frame([P2], 2)[:-1]      # lose the end of the frame, marker included
        frames = feed_all(d, broken + r.frame([P1], 3) + r.frame([P1], 4))
        # frame 2 is incomplete and frame 3 may have lost its start: both go, frame 4 arrives
        self.assertEqual([f[1] for f in frames], [4])

    def test_key_frame_survives_a_loss_before_it(self):
        """A new connection or a rotation starts with SPS: never throw that key frame away."""
        d, r = H264Depacketizer(), Rtp()
        feed_all(d, r.frame([SPS, PPS, IDR], 1))
        r.seq += 50                         # a burst of packets lost
        frames = feed_all(d, r.frame([SPS, PPS, IDR], 2))
        self.assertEqual([(f[1], f[2]) for f in frames], [(2, True)])

    def test_new_stream_resets(self):
        d = H264Depacketizer()
        feed_all(d, Rtp(ssrc=1).frame([SPS, PPS, IDR], 1))
        r2 = Rtp(ssrc=2, seq=7)
        self.assertEqual(feed_all(d, r2.frame([P1], 2)), [])          # needs a key frame again
        self.assertEqual(len(feed_all(d, r2.frame([SPS, PPS, IDR], 3))), 1)

    def test_sequence_wraps(self):
        d, r = H264Depacketizer(), Rtp(seq=0xFFFE)
        frames = feed_all(d, r.frame([SPS, PPS, IDR], 1) + r.frame([P2], 2))
        self.assertEqual(len(frames), 2)
        self.assertEqual(d.lost, 0)

    def test_garbage_is_ignored(self):
        d = H264Depacketizer()
        self.assertEqual(d.feed(b""), [])
        self.assertEqual(d.feed(b"\x00" * 40), [])
        self.assertEqual(d.feed(os.urandom(11)), [])

    def test_pack_frame(self):
        raw = pack_frame(b"abc", 90000, True, arrived_ms=1234)
        self.assertEqual(HEADER.unpack(raw[:HEADER_SIZE]), (3, 1, 1000000, 1234))
        self.assertEqual(raw[HEADER_SIZE:], b"abc")


class HelperTests(unittest.TestCase):
    def test_clean_options(self):
        cur = dict(M.DEFAULT_OPTIONS)
        out = M.clean_options({"name": "  Living room  ", "access": "pin", "quality": "sharp", "fps60": True,
                               "lowDelay": True, "fill": True, "volume": 250, "receiverOn": False}, cur)
        self.assertEqual(out, {"receiverOn": False, "name": "Living room", "access": "pin", "quality": "sharp",
                               "fps60": True, "lowDelay": True, "fill": True, "volume": 100})
        bad = M.clean_options({"name": "x\ny", "access": "everyone", "quality": "8k", "fps60": "yes",
                               "volume": "loud"}, cur)
        self.assertEqual(bad, cur)
        self.assertEqual(M.clean_options(None, cur), cur)

    def test_uxplay_args(self):
        opts = dict(M.DEFAULT_OPTIONS, name="My Deck")
        a = M.uxplay_args("/x/run.sh", opts, 5004)
        self.assertEqual(a[:5], ["/bin/sh", "/x/run.sh", "-n", "My Deck", "-nh"])
        self.assertIn("1280x720@30", a)
        self.assertEqual(a[a.index("-vrtp") + 1], "config-interval=1 mtu=16000 ! udpsink host=127.0.0.1 port=5004")
        self.assertNotIn("-pin", a)
        self.assertNotIn("-vsync", a)
        b = M.uxplay_args("/x/run.sh", dict(opts, access="pin", quality="sharp", fps60=True, lowDelay=True),
                          5006, pin="4321", register="/r.txt")
        self.assertIn("1920x1080@60", b)
        self.assertTrue(b[b.index("-vrtp") + 1].endswith("port=5006 sync=false"))
        self.assertEqual(b[b.index("-vsync") + 1], "no")
        self.assertEqual(b[b.index("-pin") + 1], "4321")
        self.assertEqual(b[b.index("-reg") + 1], "/r.txt")
        # a PIN that is not four digits is never passed on
        self.assertNotIn("-pin", M.uxplay_args("/x/run.sh", dict(opts, access="pin"), 5004, pin="12"))

    def test_established_local_ports(self):
        tcp = ("  sl  local_address rem_address   st tx_queue rx_queue\n"
               "   0: 00000000:1B58 00000000:0000 0A 00000000:00000000\n"       # 7000 listening
               "   1: 0A00000F:1B58 0A000014:C001 01 00000000:00000000\n"       # 7000 established
               "   2: 0A00000F:1BBC 0A000014:C002 01 00000000:00000000\n")      # 7100 established
        tcp6 = ("  sl  local_address remote_address st\n"
                "   0: 00000000000000000000000000000000:1B58 00000000000000000000000000000000:0000 0A\n")
        self.assertEqual(M.established_local_ports([tcp, tcp6]), {7000: 1, 7100: 1})
        self.assertEqual(M.established_local_ports(["garbage\nmore garbage"]), {})

    def test_find_streams(self):
        dump = [{"type": "PipeWire:Interface:Node", "id": 71,
                 "info": {"props": {"media.class": "Stream/Output/Audio", "application.name": "Chromium"}}},
                {"type": "PipeWire:Interface:Node", "id": 88,
                 "info": {"props": {"media.class": "Stream/Output/Audio", "application.name": M.STREAM_NAME}}},
                {"type": "PipeWire:Interface:Node", "id": 90,
                 "info": {"props": {"media.class": "Audio/Sink", "application.name": M.STREAM_NAME}}}]
        self.assertEqual(M.find_pw_stream(dump), 88)
        self.assertIsNone(M.find_pw_stream({"not": "a list"}))
        sinks = [{"index": 5, "properties": {"application.name": "Steam"}},
                 {"index": 9, "properties": {"application.process.binary": "uxplay"}}]
        self.assertEqual(M.find_pa_stream(sinks), 9)
        self.assertIsNone(M.find_pa_stream([]))


def http(url, data=None):
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status, r.read()


class MirrorServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        os.makedirs(os.path.join(t, "plugin", "assets"))
        with open(os.path.join(ROOT, "assets", "player.html"), "rb") as src, \
                open(os.path.join(t, "plugin", "assets", "player.html"), "wb") as dst:
            dst.write(src.read())
        self.session = {"connected": True, "mirroring": True}
        self.m = M.Mirror(plugin_dir=os.path.join(t, "plugin"), settings_dir=os.path.join(t, "settings"),
                          home=os.path.join(t, "home"), user="deck", log=logging.getLogger("test"), version="t",
                          session_fn=lambda: dict(self.session))
        await self.m.start({"receiverOn": False})
        self.base = "http://127.0.0.1:%d" % self.m.port

    async def asyncTearDown(self):
        await self.m.stop()
        self.tmp.cleanup()

    def send_rtp(self, packets):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for p in packets:
            s.sendto(p, ("127.0.0.1", self.m.rtp_port))
        s.close()

    async def read_frames(self, count, timeout=5):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.m.port)
        writer.write(("GET /stream?s=%s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n\r\n" % (self.m.secret, self.m.port)).encode())
        await reader.readuntil(b"\r\n\r\n")
        frames = []
        try:
            while len(frames) < count:
                head = await asyncio.wait_for(reader.readexactly(HEADER_SIZE), timeout)
                n, flags, ts, _arrived = HEADER.unpack(head)
                frames.append((await reader.readexactly(n), ts, flags))
        finally:
            writer.close()
        return frames

    async def test_starts_without_receiver_and_keeps_a_pin(self):
        st = self.m.state()
        self.assertTrue(st["ok"], st)
        self.assertEqual(st["receiver"], {"state": "off", "message": "", "bundled": False})
        self.assertRegex(self.m.pin, r"^\d{4}$")
        self.assertEqual(st["pin"], "")                    # only shown when a PIN is required
        with open(os.path.join(self.tmp.name, "settings", "receiver.json"), encoding="utf-8") as fh:
            saved = json.load(fh)
        self.assertEqual(saved["pin"], self.m.pin)

    async def test_video_reaches_a_late_viewer(self):
        r = Rtp()
        self.send_rtp(r.frame([SPS, PPS, IDR], 9000) + r.frame([P1], 12000))
        await asyncio.sleep(0.3)
        self.assertEqual(self.m.frames, 2)
        # a page that connects only now still gets the key frame first
        task = asyncio.ensure_future(self.read_frames(3))
        await asyncio.sleep(0.3)
        self.send_rtp(r.frame([P2], 15000))
        frames = await task
        self.assertEqual(frames[0], (annexb(SPS, PPS, IDR), 100000, 1))
        self.assertEqual(frames[1], (annexb(P1), 133333, 0))
        self.assertEqual(frames[2][0], annexb(P2))
        self.assertTrue(self.m.state()["receiving"])

    async def test_page_and_api_need_the_secret(self):
        loop = asyncio.get_running_loop()
        status, body = await loop.run_in_executor(None, http, self.base + "/player?s=" + self.m.secret)
        self.assertEqual(status, 200)
        self.assertIn(b"PiP Theater mirror", body)
        for path in ("/player", "/player?s=wrong", "/stream?s=", "/api/report?s=nope"):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                await loop.run_in_executor(None, http, self.base + path)
            self.assertEqual(cm.exception.code, 403, path)

    async def test_report_roundtrip(self):
        loop = asyncio.get_running_loop()
        self.m.options["fill"] = True
        body = json.dumps({"w": 1170, "h": 2532, "fps": 29.97, "decoded": 10, "support": "yes", "delay": 42}).encode()
        status, raw = await loop.run_in_executor(None, http, self.base + "/api/report?s=" + self.m.secret, body)
        page = json.loads(raw)
        self.assertEqual((status, page["fill"], page["receiver"], page["pin"]), (200, True, "off", ""))
        rep = self.m.state()["report"]
        self.assertEqual((rep["w"], rep["h"], rep["fps"], rep["support"], rep["delay"]), (1170, 2532, 30.0, "yes", 42))

    async def test_old_picture_is_forgotten_when_mirroring_stops(self):
        self.m.rc_state = "running"
        r = Rtp()
        self.send_rtp(r.frame([SPS, PPS, IDR], 1))
        await asyncio.sleep(1.3)
        self.assertIsNotNone(self.m.gop)
        self.assertTrue(self.m.state()["session"]["mirroring"])
        self.session = {"connected": False, "mirroring": False}
        await asyncio.sleep(1.3)
        self.assertIsNone(self.m.gop)

    async def test_configure_starts_stops_and_restarts(self):
        calls = []

        async def start():
            calls.append("start")
            self.m.rc_state = "running"

        async def stop():
            calls.append("stop")

        self.m._rc_start, self.m._rc_stop = start, stop
        res = await self.m.configure({"receiverOn": True})
        self.assertEqual((calls, res["restarted"]), (["start"], False))
        res = await self.m.configure({"fill": True, "volume": 40})           # page-side options: no restart
        self.assertEqual((calls, res["restarted"]), (["start"], False))
        res = await self.m.configure({"quality": "sharp"})                    # receiver option: restart
        self.assertEqual((calls, res["restarted"]), (["start", "stop", "start"], True))
        res = await self.m.configure({"receiverOn": False})
        self.assertEqual((calls[-1], self.m.rc_state), ("stop", "off"))

    async def test_missing_bundle_is_reported_not_retried(self):
        await self.m.configure({"receiverOn": True})
        self.assertEqual(self.m.rc_state, "error")
        self.assertIn("no AirPlay receiver", self.m.rc_message)
        restarts = []

        async def restart(why):
            restarts.append(why)

        self.m._restart = restart
        for _ in range(5):
            await self.m.guard(0, "10.0.0.5")
        self.assertEqual(restarts, [])

    async def test_guard_recovers_from_sleep_network_change_and_crash(self):
        restarts = []

        async def restart(why):
            restarts.append(why)

        self.m._restart = restart
        self.m.options["receiverOn"] = True
        self.m.rc_state = "running"
        self.m.last_ip = "10.0.0.5"
        await self.m.guard(0, "10.0.0.5")
        self.assertEqual(restarts, [])
        await self.m.guard(40, "10.0.0.5")
        await self.m.guard(0, "10.0.0.9")
        self.assertEqual(restarts, ["the Deck woke from sleep", "the network changed"])
        self.m.rc_state, self.m.rc_message = "error", "The receiver stopped: boom"
        await self.m.guard(0, "10.0.0.9")                 # schedules the first retry
        self.assertEqual(len(restarts), 2)
        self.m.next_restart = 1                           # ... which is now due
        await self.m.guard(0, "10.0.0.9")
        self.assertEqual(restarts[-1], "it stopped by itself (try 1)")


if __name__ == "__main__":
    unittest.main()
