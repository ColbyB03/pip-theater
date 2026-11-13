"""Phone mirroring for PiP Theater.

    phone --AirPlay--> UxPlay (the AirPlay receiver shipped in bin/uxplay-steamos)
          --RTP/H.264 on 127.0.0.1--> this module --HTTP stream--> the PiP page (WebCodecs)

Sound is played by the receiver itself, as its own stream, so it has its own volume.
Standard library only. Nothing here imports `decky`, so it runs under the tests as well.
The overall approach follows decky-screen-mirror (BSD-3-Clause, see LICENSE).
"""
import asyncio
import json
import os
import re
import shutil
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from h264 import H264Depacketizer, pack_frame

PORT_START = 8795             # the PiP page and its video stream (this device only)
PORT_TRIES = 12
RTP_PORT = 5004               # where the receiver sends the video
MAX_BODY = 4096
QUEUE_FRAMES = 300            # a page this far behind is restarted from the kept frames
GOP_MAX_BYTES = 64 << 20      # most we keep of "the last key frame and everything since"
BUNDLE = "uxplay-steamos"
AIRPLAY_CONTROL_PORT = 7000   # with "-p": the phone holds a TCP connection here while connected,
AIRPLAY_MIRROR_PORT = 7100    # and another one here while it mirrors its screen
STREAM_NAME = "PiP Theater Mirror"   # the receiver's sound stream in PipeWire / PulseAudio
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
LOCAL_HOSTS = ("127.0.0.1", "localhost", "[::1]")
WAKE_GAP = 15                 # wall clock ran this far ahead of the monotonic clock: we slept
RESTART_DELAYS = (3, 10, 30, 60, 120)   # waits before each automatic restart after a crash

QUALITY = {"sharp": "1920x1080", "balanced": "1280x720", "saver": "960x540"}
NAME_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,40}$")
DEFAULT_OPTIONS: Dict[str, Any] = {
    "receiverOn": True,
    "name": "Steam Deck",
    "access": "anyone",       # "anyone" on the Wi-Fi, or "pin": a new phone types a PIN once
    "quality": "balanced",
    "fps60": False,
    "lowDelay": False,
    "fill": False,            # crop the picture to fill the window (the page does this)
    "volume": 100,
}
RESTART_KEYS = ("name", "access", "quality", "fps60", "lowDelay")

# What the receiver needs from GStreamer. The last two come with the plugin when SteamOS lacks them.
NEEDED_ELEMENTS = ("appsrc", "queue", "rtph264pay", "udpsink", "pulsesink", "avdec_aac", "h264parse")


# --------------------------------------------------------------------------- #
# Pure helpers
# --------------------------------------------------------------------------- #

def _same(a: str, b: str) -> bool:
    """Constant-time string comparison."""
    if not isinstance(a, str) or not isinstance(b, str) or len(a) != len(b):
        return False
    r = 0
    for x, y in zip(a, b):
        r |= ord(x) ^ ord(y)
    return r == 0


def _num(v: Any, lo: float, hi: float, default: float = 0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:
        return default
    return max(lo, min(hi, f))


def load_json(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def save_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, path)


def _load_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def clean_options(raw: Any, current: Dict[str, Any]) -> Dict[str, Any]:
    """Validate options coming from the panel; anything invalid keeps its current value."""
    raw = raw if isinstance(raw, dict) else {}
    out = dict(current)
    name = raw.get("name")
    if isinstance(name, str) and NAME_RE.match(name.strip()):
        out["name"] = name.strip()
    if raw.get("access") in ("anyone", "pin"):
        out["access"] = raw["access"]
    if raw.get("quality") in QUALITY:
        out["quality"] = raw["quality"]
    for k in ("receiverOn", "fps60", "lowDelay", "fill"):
        if isinstance(raw.get(k), bool):
            out[k] = raw[k]
    if "volume" in raw:
        out["volume"] = int(_num(raw.get("volume"), 0, 100, out.get("volume", 100)))
    return out


def uxplay_args(launcher: str, opts: Dict[str, Any], rtp_port: int, pin: str = "", register: str = "") -> List[str]:
    """UxPlay as a windowless AirPlay receiver: video forwarded to us as RTP, sound to the Deck."""
    low = bool(opts.get("lowDelay"))
    fps = 60 if opts.get("fps60") else 30
    size = QUALITY.get(opts.get("quality", "balanced"), QUALITY["balanced"])
    # config-interval=1: parameter sets in front of every key frame (see h264.py).
    # mtu: loopback carries big datagrams, so a key frame is tens of packets instead of hundreds.
    rtp = "config-interval=1 mtu=16000 ! udpsink host=127.0.0.1 port=%d%s" % (rtp_port, " sync=false" if low else "")
    args = ["/bin/sh", launcher,
            "-n", str(opts.get("name") or "Steam Deck"), "-nh",
            "-p",          # fixed ports: we watch TCP 7000 / 7100 to know a phone is connected
            "-nohold",     # a phone that connects takes over from a stale connection
            "-vrtp", rtp,
            "-as", "pulsesink",
            "-s", "%s@%d" % (size, fps), "-fps", str(fps)]
    if low:
        args += ["-vsync", "no"]
    if opts.get("access") == "pin" and len(pin) == 4 and pin.isdigit():
        args += ["-pin", pin]              # a new phone must type this once ...
        if register:
            args += ["-reg", register]     # ... and is remembered after that
    return args


def established_local_ports(texts: List[str]) -> Dict[int, int]:
    """/proc/net/tcp and tcp6 contents -> {local port: number of ESTABLISHED connections}."""
    out: Dict[int, int] = {}
    for text in texts:
        for ln in text.splitlines()[1:]:
            f = ln.split()
            if len(f) < 4 or f[3] != "01":   # 01 = ESTABLISHED
                continue
            try:
                port = int(f[1].rsplit(":", 1)[1], 16)
            except (ValueError, IndexError):
                continue
            out[port] = out.get(port, 0) + 1
    return out


def airplay_session() -> Dict[str, bool]:
    """Is a phone connected / mirroring? Read from the open connections, not from the video:
    a phone sends no video at all while its screen does not change."""
    texts = []
    for name in ("tcp", "tcp6"):
        try:
            with open("/proc/net/" + name, "r") as fh:
                texts.append(fh.read())
        except OSError:
            pass
    ports = established_local_ports(texts)
    return {"connected": AIRPLAY_CONTROL_PORT in ports or AIRPLAY_MIRROR_PORT in ports,
            "mirroring": AIRPLAY_MIRROR_PORT in ports}


def _is_receiver_stream(props: Dict[str, Any]) -> bool:
    return (str(props.get("application.process.binary", "")) == "uxplay"
            or str(props.get("application.name", "")) in (STREAM_NAME, "uxplay"))


def find_pw_stream(dump: Any) -> Optional[int]:
    """pw-dump output -> id of the receiver's playback stream, if it is playing."""
    for obj in dump if isinstance(dump, list) else []:
        if not isinstance(obj, dict) or obj.get("type") != "PipeWire:Interface:Node":
            continue
        props = ((obj.get("info") or {}).get("props")) or {}
        if str(props.get("media.class", "")).startswith("Stream/Output/Audio") and _is_receiver_stream(props):
            return int(obj["id"])
    return None


def find_pa_stream(sink_inputs: Any) -> Optional[int]:
    """`pactl -f json list sink-inputs` -> index of the receiver's stream."""
    for si in sink_inputs if isinstance(sink_inputs, list) else []:
        if isinstance(si, dict) and _is_receiver_stream(si.get("properties") or {}):
            return int(si["index"])
    return None


def lan_ip() -> Optional[str]:
    """This device's address on the local network (None when offline). Nothing is sent."""
    try:
        import socket

        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
        finally:
            s.close()
        return ip if ip and not ip.startswith("127.") else None
    except Exception:
        return None


def _which(name: str, env: Dict[str, str]) -> Optional[str]:
    for d in env.get("PATH", "").split(":"):
        p = os.path.join(d, name)
        if d and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


async def _run(args: List[str], env: Dict[str, str], timeout: float = 6) -> Tuple[int, str]:
    p = await asyncio.create_subprocess_exec(*args, env=env, stdin=asyncio.subprocess.DEVNULL,
                                             stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
    except asyncio.TimeoutError:
        p.kill()
        raise
    return p.returncode or 0, out.decode("utf-8", "replace")


class _Rtp(asyncio.DatagramProtocol):
    def __init__(self, mirror: "Mirror") -> None:
        self.mirror = mirror

    def datagram_received(self, data, addr):
        self.mirror.on_rtp(data)


class _Viewer:
    def __init__(self) -> None:
        self.q: "asyncio.Queue[bytes]" = asyncio.Queue()


# --------------------------------------------------------------------------- #
# The mirror service
# --------------------------------------------------------------------------- #

class Mirror:
    def __init__(self, *, plugin_dir: str, settings_dir: str, home: str, user: str, log: Any, version: str,
                 session_fn: Callable[[], Dict[str, bool]] = airplay_session) -> None:
        self.plugin_dir = plugin_dir
        self.settings_dir = settings_dir
        self.home = home
        self.user = user
        self.log = log
        self.version = version
        self.session_fn = session_fn
        self.work_dir = os.path.join(home, ".local", "share", "pip-theater")
        self.options: Dict[str, Any] = dict(DEFAULT_OPTIONS)
        self.pin = ""
        self.secret = os.urandom(8).hex()
        self.server = None
        self.server6 = None
        self.port: Optional[int] = None
        self.rtp = None
        self.rtp_port: Optional[int] = None
        self.start_error: Optional[str] = None
        self.player_html = b""
        self.depack = H264Depacketizer()
        self.viewers: List[_Viewer] = []
        self.gop: Optional[List[bytes]] = None     # last key frame and every frame since (packed)
        self.gop_bytes = 0
        self.gop_dropped = False                   # the kept frames grew too big and were let go
        self.frames = 0
        self.last_packet = 0.0
        self.session = {"connected": False, "mirroring": False}
        self.client = ""
        self.req_seq = 0
        self.report: Dict[str, Any] = {}
        self.report_ts = 0.0
        self.rc_state = "off"                      # "off" | "running" | "error"
        self.rc_message = ""
        self.rc_output: List[str] = []
        self.rc_proc = None
        self.rc_stopping = False
        self.crashes: List[float] = []
        self.next_restart = 0.0
        self.recoveries: List[str] = []
        self.last_ip: Optional[str] = None
        self.vol_applied: Optional[str] = None     # which stream the saved volume was applied to
        self.tasks: List[Any] = []

    # ---- lifecycle ---------------------------------------------------------- #

    async def start(self, options: Any) -> None:
        self.options = clean_options(options, DEFAULT_OPTIONS)
        self._load_pin()
        try:
            with open(os.path.join(self.plugin_dir, "assets", "player.html"), "rb") as fh:
                self.player_html = fh.read()
        except OSError as exc:
            self.start_error = "The plugin is incomplete (assets/player.html): %s" % exc
        await self._start_server()
        await self._start_rtp()
        if self.options["receiverOn"]:
            await self._rc_start()
        self.tasks = [asyncio.ensure_future(self._session_loop()), asyncio.ensure_future(self._guard_loop())]

    async def stop(self) -> None:
        for t in self.tasks:
            t.cancel()
        self.tasks = []
        await self._rc_stop()
        if self.rtp is not None:
            self.rtp.close()
            self.rtp = None
        for srv in (self.server6, self.server):
            if srv is not None:
                srv.close()
        self.server = self.server6 = None

    def _load_pin(self) -> None:
        path = os.path.join(self.settings_dir, "receiver.json")
        data = load_json(path, {})
        pin = data.get("pin") if isinstance(data, dict) else None
        if not (isinstance(pin, str) and len(pin) == 4 and pin.isdigit()):
            pin = "%04d" % (1000 + int.from_bytes(os.urandom(2), "big") % 9000)
            try:
                save_json(path, {"pin": pin})
            except OSError as exc:
                self.log.error("could not save the PIN: %s", exc)
        self.pin = pin

    async def _start_server(self) -> None:
        for port in range(PORT_START, PORT_START + PORT_TRIES):
            try:
                self.server = await asyncio.start_server(self._handle, "127.0.0.1", port, limit=16384)
            except OSError:
                continue
            self.port = port
            try:   # browsers often try IPv6 first for "localhost"
                self.server6 = await asyncio.start_server(self._handle, "::1", port, limit=16384)
            except OSError:
                self.server6 = None
            self.log.info("mirror page on localhost:%s", port)
            return
        self.start_error = "Could not open a local port for the mirror page."

    async def _start_rtp(self) -> None:
        loop = asyncio.get_event_loop()
        for port in range(RTP_PORT, RTP_PORT + 20, 2):
            try:
                self.rtp, _ = await loop.create_datagram_endpoint(lambda: _Rtp(self), local_addr=("127.0.0.1", port))
            except OSError:
                continue
            try:   # key frames arrive as a burst: a big buffer keeps them from being dropped
                import socket

                self.rtp.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
            except Exception:
                pass
            self.rtp_port = port
            self.log.info("mirror video in on udp 127.0.0.1:%s", port)
            return
        self.start_error = "Could not open the video port."

    # ---- video in -> pages --------------------------------------------------- #

    def on_rtp(self, data: bytes) -> None:
        """New video from the receiver. A phone sends a key frame (a whole picture) only when
        mirroring starts or the screen rotates; after that only changes. So the last key frame
        and every frame since are kept, and a page that connects later (or falls behind, or
        had a decoder error) gets them first and can always rebuild the picture."""
        self.last_packet = time.time()
        for frame, ts, key in self.depack.feed(data):
            self.frames += 1
            packed = pack_frame(frame, ts, key)
            if key:
                self.gop, self.gop_bytes, self.gop_dropped = [packed], len(packed), False
            elif self.gop is not None:
                self.gop.append(packed)
                self.gop_bytes += len(packed)
                if self.gop_bytes > GOP_MAX_BYTES:
                    self.log.info("the key frame is %d frames back, too much to keep", len(self.gop))
                    self.gop, self.gop_bytes, self.gop_dropped = None, 0, True
            for v in self.viewers:
                if v.q.qsize() >= QUEUE_FRAMES and self.gop:
                    while not v.q.empty():     # far behind: restart it from the last key frame
                        v.q.get_nowait()
                    for f in self.gop:
                        v.q.put_nowait(f)
                    continue
                v.q.put_nowait(packed)

    def _forget_picture(self) -> None:
        self.gop, self.gop_bytes, self.gop_dropped = None, 0, False

    # ---- HTTP (this device only) --------------------------------------------- #

    def _local_ok(self, headers: Dict[str, str], peer_ip: str, q: Dict[str, List[str]]) -> bool:
        if peer_ip not in LOOPBACK:
            return False
        h = headers.get("host", "")
        host = h.split("]")[0] + "]" if h.startswith("[") else h.rsplit(":", 1)[0] if ":" in h else h
        return host in LOCAL_HOSTS and _same((q.get("s") or [""])[0], self.secret)

    async def _handle(self, reader, writer) -> None:
        try:
            peer = writer.get_extra_info("peername")
            peer_ip = peer[0] if peer else ""
            try:
                head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            except Exception:
                return
            lines = head.decode("latin-1").split("\r\n")
            try:
                method, target, _ = lines[0].split(" ", 2)
            except ValueError:
                return
            headers: Dict[str, str] = {}
            for ln in lines[1:]:
                if ":" in ln:
                    k, v = ln.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            try:
                n = int(headers.get("content-length", "0") or 0)
            except ValueError:
                n = -1
            if n < 0 or n > MAX_BODY:
                await self._send(writer, 413, "text/plain", b"too large")
                return
            body = await asyncio.wait_for(reader.readexactly(n), 5) if n else b""
            u = urlparse(target)
            q = parse_qs(u.query)
            if not self._local_ok(headers, peer_ip, q):
                await self._send(writer, 403, "text/plain", b"forbidden")
                return
            if u.path == "/player" and method == "GET":
                await self._send(writer, 200, "text/html; charset=utf-8", self.player_html)
            elif u.path == "/stream" and method == "GET":
                await self._stream(writer)
            elif u.path == "/api/report" and method == "POST":
                try:
                    d = json.loads(body.decode("utf-8") or "{}")
                except Exception:
                    d = {}
                self._on_report(d if isinstance(d, dict) else {})
                await self._send(writer, 200, "application/json", json.dumps(self._page_state()).encode())
            else:
                await self._send(writer, 404, "text/plain", b"not found")
        except Exception as exc:
            self.log.error("mirror http error: %s", exc)
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _send(self, writer, status: int, ctype: str, data: bytes) -> None:
        reason = {200: "OK", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large"}.get(status, "OK")
        writer.write(("HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\n"
                      "X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
                      % (status, reason, ctype, len(data))).encode("latin-1") + data)
        await writer.drain()

    async def _stream(self, writer) -> None:
        """One long response carrying frames as they arrive (the page reads it with fetch())."""
        v = _Viewer()
        for f in self.gop or []:     # start from the last key frame, so the picture shows at once
            v.q.put_nowait(f)
        self.viewers.append(v)
        try:
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nCache-Control: no-store\r\n"
                         b"Connection: close\r\n\r\n")
            await writer.drain()
            while True:
                try:
                    data = await asyncio.wait_for(v.q.get(), 10)
                except asyncio.TimeoutError:
                    data = pack_frame(b"", 0, False)    # keep-alive
                writer.write(data)
                await writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            if v in self.viewers:
                self.viewers.remove(v)

    def _page_state(self) -> Dict[str, Any]:
        return {"ok": True,
                "connected": self.session["connected"], "mirroring": self.session["mirroring"],
                "fill": bool(self.options.get("fill")),
                "name": self.options.get("name", ""),
                "receiver": self.rc_state,
                "picture_lost": self.gop_dropped,
                "pin": self.pin if self.options.get("access") == "pin" else ""}

    def _on_report(self, d: Dict[str, Any]) -> None:
        self.report = {
            "w": int(_num(d.get("w"), 0, 10000)), "h": int(_num(d.get("h"), 0, 10000)),
            "fps": round(_num(d.get("fps"), 0, 240), 1),
            "decoded": int(_num(d.get("decoded"), 0, 1e12)), "dropped": int(_num(d.get("dropped"), 0, 1e12)),
            "restarts": int(_num(d.get("restarts"), 0, 1e6)),
            "codec": str(d.get("codec") or "")[:40], "error": str(d.get("error") or "")[:200],
            "support": str(d.get("support") or "")[:20],
            "delay": int(_num(d.get("delay"), 0, 60000)),
        }
        self.report_ts = time.time()

    # ---- the AirPlay receiver ------------------------------------------------ #

    def env(self) -> Dict[str, str]:
        """Environment for system tools: Decky is a bundled app, so undo what it changed."""
        env = dict(os.environ)
        orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
        if orig is not None:
            env["LD_LIBRARY_PATH"] = orig
        else:
            env.pop("LD_LIBRARY_PATH", None)
        env.pop("LD_PRELOAD", None)
        uid = os.getuid() if hasattr(os, "getuid") else 1000
        env["HOME"] = self.home
        env.setdefault("USER", self.user or os.path.basename(self.home))
        env.setdefault("XDG_RUNTIME_DIR", "/run/user/%d" % uid)
        env.setdefault("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/%d/bus" % uid)
        env["PATH"] = ":".join([os.path.join(self.home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin",
                                env.get("PATH", "")])
        return env

    def _register_file(self) -> str:
        return os.path.join(self.work_dir, "approved-phones.txt")

    def bundle_version(self) -> str:
        return _load_text(os.path.join(self.plugin_dir, "bin", BUNDLE, "VERSION"))

    def _prepare(self) -> str:
        """Copy the bundled receiver to a folder we own and make it executable (a ZIP install can
        drop the executable flag, and the plugin folder may not be writable). Returns the launcher."""
        src = os.path.join(self.plugin_dir, "bin", BUNDLE)
        dst = os.path.join(self.work_dir, BUNDLE)
        want = self.bundle_version()
        if not want:
            raise RuntimeError("This build has no AirPlay receiver (bin/%s). "
                               "Install the release ZIP from the plugin's GitHub page." % BUNDLE)
        launcher = _load_text(os.path.join(src, "run.sh"))
        if _load_text(os.path.join(dst, "VERSION")) != want or _load_text(os.path.join(dst, "run.sh")) != launcher:
            shutil.rmtree(dst, ignore_errors=True)
            shutil.copytree(src, dst)
        for root, _dirs, files in os.walk(dst):
            for f in files:
                if f in ("uxplay", "run.sh") or ".so" in f:
                    os.chmod(os.path.join(root, f), 0o755)
        return os.path.join(dst, "run.sh")

    async def _rc_start(self) -> None:
        self.next_restart = 0.0
        if self.rc_proc is not None and self.rc_proc.returncode is None:
            return
        if self.rtp_port is None:
            self.rc_state, self.rc_message = "error", "No video port, so the receiver can't start."
            return
        try:
            launcher = self._prepare()
            env = self.env()
            env["PULSE_PROP"] = 'application.name="%s"' % STREAM_NAME    # so its sound stream can be found
            args = uxplay_args(launcher, self.options, self.rtp_port, self.pin, self._register_file())
            self.rc_proc = await asyncio.create_subprocess_exec(
                *args, env=env, cwd=os.path.dirname(launcher), stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        except Exception as exc:
            self.rc_state, self.rc_message = "error", str(exc) or type(exc).__name__
            self.log.error("could not start the AirPlay receiver: %s", self.rc_message)
            return
        self.rc_state, self.rc_message, self.rc_output, self.rc_stopping = "running", "", [], False
        self.depack.reset()
        self._forget_picture()
        asyncio.ensure_future(self._rc_watch(self.rc_proc))
        self.log.info("AirPlay receiver started as \"%s\"", self.options.get("name"))

    async def _rc_watch(self, proc) -> None:
        """Keep the receiver's output for Check setup / the log, and notice when it stops."""
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            self.rc_output = (self.rc_output + [line[:200]])[-80:]
            self.log.info("uxplay: %s", line[:300])
            if line.startswith("connection request from "):
                self.req_seq += 1
                who = line[len("connection request from "):].split(" with deviceID", 1)[0]
                self.client = who.split(" (", 1)[0].strip()[:60] or "Phone"
        await proc.wait()
        if proc is self.rc_proc and not self.rc_stopping:
            self.rc_state = "error"
            self.rc_message = "The receiver stopped: %s" % ((self.rc_output or ["no output"])[-1])
            self.log.error(self.rc_message)

    async def _rc_stop(self) -> None:
        proc, self.rc_proc = self.rc_proc, None
        if proc is None or proc.returncode is not None:
            return
        self.rc_stopping = True
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), 5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    async def _restart(self, why: str) -> None:
        self.log.info("restarting the AirPlay receiver: %s", why)
        self.recoveries = (self.recoveries + [time.strftime("%H:%M ") + why])[-10:]
        await self._rc_stop()
        await self._rc_start()

    # ---- keeping it alive ---------------------------------------------------- #

    async def guard(self, wall_gap: float, ip: Optional[str]) -> None:
        """One check, every few seconds. After the Deck sleeps or its network changes, phones no
        longer see the receiver until it announces itself again: restart it. After a crash:
        restart it, waiting longer each time, and give up after several in ten minutes."""
        if not self.options.get("receiverOn"):
            return
        now = time.time()
        if self.rc_state == "running" and wall_gap > WAKE_GAP:
            await self._restart("the Deck woke from sleep")
        elif self.rc_state == "running" and ip and self.last_ip and ip != self.last_ip:
            await self._restart("the network changed")
        elif self.rc_state == "error" and "no AirPlay receiver" not in self.rc_message:
            self.crashes = [t for t in self.crashes if now - t < 600]
            n = len(self.crashes)
            if n >= len(RESTART_DELAYS):
                if not self.rc_message.endswith("(gave up restarting)"):
                    self.rc_message += " (gave up restarting)"
                return
            if not self.next_restart:
                self.next_restart = now + RESTART_DELAYS[n]
            elif now >= self.next_restart:
                self.next_restart = 0.0
                self.crashes.append(now)
                await self._restart("it stopped by itself (try %d)" % (n + 1))
        if ip:
            self.last_ip = ip

    async def _guard_loop(self) -> None:
        self.last_ip = lan_ip()
        wall, mono = time.time(), time.monotonic()
        while True:
            await asyncio.sleep(5)
            w, m = time.time(), time.monotonic()
            try:
                await self.guard((w - wall) - (m - mono), lan_ip())
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.log.error("mirror guard: %s", exc)
            wall, mono = w, m

    async def _session_loop(self) -> None:
        """Track whether a phone is connected; give a newly connected phone the saved volume."""
        tick = 0
        while True:
            await asyncio.sleep(1)
            tick += 1
            try:
                was = self.session
                self.session = self.session_fn() if self.rc_state == "running" else {"connected": False, "mirroring": False}
                if was["mirroring"] and not self.session["mirroring"]:
                    self._forget_picture()      # never show an old picture to the next viewer
                if not self.session["connected"]:
                    self.vol_applied = None
                elif self.vol_applied is None and tick % 2 == 0:
                    ok, how = await self._apply_volume(self.options.get("volume", 100))
                    if ok:
                        self.vol_applied = how
                        self.log.info("mirror volume %s%% applied (%s)", self.options.get("volume"), how)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.log.error("mirror session loop: %s", exc)

    # ---- mirror volume ------------------------------------------------------- #

    async def _apply_volume(self, percent: Any) -> Tuple[bool, str]:
        """Set the volume of just the receiver's sound stream, like a per-app mixer."""
        level = int(_num(percent, 0, 100, 100))
        env = self.env()
        if _which("pw-dump", env) and _which("wpctl", env):
            try:
                code, out = await _run(["pw-dump"], env)
                sid = find_pw_stream(json.loads(out)) if code == 0 else None
                if sid is not None:
                    code, _ = await _run(["wpctl", "set-volume", str(sid), "%.2f" % (level / 100.0)], env)
                    if code == 0:
                        return True, "wpctl %d" % sid
            except Exception as exc:
                self.log.error("volume via wpctl: %s", exc)
        if _which("pactl", env):
            try:
                code, out = await _run(["pactl", "-f", "json", "list", "sink-inputs"], env)
                idx = find_pa_stream(json.loads(out)) if code == 0 else None
                if idx is not None:
                    code, _ = await _run(["pactl", "set-sink-input-volume", str(idx), "%d%%" % level], env)
                    if code == 0:
                        return True, "pactl %d" % idx
            except Exception as exc:
                self.log.error("volume via pactl: %s", exc)
        return False, "no sound stream yet"

    # ---- called from the panel ------------------------------------------------ #

    async def configure(self, raw: Any) -> Dict[str, Any]:
        """Apply the mirror options. Turning the receiver on/off starts/stops it; changing how it
        presents itself (name, access, quality...) restarts it, so a mirroring phone reconnects."""
        old = dict(self.options)
        new = clean_options(raw, old)
        self.options = new
        restarted = False
        if not new["receiverOn"]:
            if self.rc_proc is not None or self.rc_state != "off":
                await self._rc_stop()
                self.rc_state, self.rc_message = "off", ""
        elif self.rc_state == "off" or not old["receiverOn"]:
            self.crashes = []
            await self._rc_start()
        elif any(new[k] != old[k] for k in RESTART_KEYS):
            self.crashes = []
            await self._rc_stop()
            await self._rc_start()
            restarted = self.rc_state == "running"
        if new["volume"] != old["volume"] and self.session["connected"]:
            ok, how = await self._apply_volume(new["volume"])
            if ok:
                self.vol_applied = how
        return {"ok": True, "restarted": restarted, "options": new}

    async def retry(self) -> Dict[str, Any]:
        """Start the receiver again after it gave up."""
        self.crashes = []
        await self._rc_stop()
        if self.options["receiverOn"]:
            await self._rc_start()
        return {"ok": self.rc_state == "running", "message": self.rc_message}

    async def forget_phones(self) -> Dict[str, Any]:
        try:
            os.remove(self._register_file())
        except FileNotFoundError:
            pass
        except OSError as exc:
            return {"ok": False, "message": "Could not forget the phones: %s" % exc}
        if self.rc_state in ("running", "error") and self.options["receiverOn"]:
            await self._rc_stop()
            await self._rc_start()
        return {"ok": True, "message": "Approved phones forgotten: each must type the PIN again."}

    def state(self) -> Dict[str, Any]:
        now = time.time()
        rep = dict(self.report)
        rep["age"] = round(now - self.report_ts, 1) if self.report_ts else None
        return {
            "ok": self.server is not None and self.rtp is not None and not self.start_error,
            "version": self.version,
            "error": self.start_error,
            "player_url": ("http://localhost:%s/player?s=%s" % (self.port, self.secret)) if self.port else None,
            "rtp_port": self.rtp_port,
            "receiving": bool(self.last_packet and now - self.last_packet < 2),
            "session": dict(self.session),
            "client": self.client,
            "options": dict(self.options),
            "pin": self.pin if self.options.get("access") == "pin" else "",
            "req_seq": self.req_seq,
            "receiver": {"state": self.rc_state, "message": self.rc_message, "bundled": bool(self.bundle_version())},
            "recoveries": self.recoveries[-3:],
            "volume_applied": self.vol_applied is not None,
            "frames": self.frames,
            "lost": self.depack.lost,
            "picture_lost": self.gop_dropped,
            "viewers": len(self.viewers),
            "report": rep,
        }

    async def system_check(self) -> Dict[str, Any]:
        """Can the receiver run here? Checks each GStreamer element it uses, with the bundled ones
        added. Read-only (runs gst-inspect-1.0 with a private registry), needs no password."""
        env = self.env()
        out: Dict[str, Any] = {"os": "", "gstreamer": False, "elements": {}, "bundle": self.bundle_version(),
                               "receiver_output": self.rc_output[-15:], "recoveries": list(self.recoveries)}
        try:
            with open("/etc/os-release", "r", encoding="utf-8") as fh:
                info = dict(ln.strip().split("=", 1) for ln in fh if "=" in ln)
            out["os"] = ("%s %s" % (info.get("NAME", "").strip('"'), info.get("VERSION_ID", "").strip('"'))).strip()[:40]
        except Exception:
            pass
        try:
            gst_dir = os.path.join(os.path.dirname(self._prepare()), "gst")
            env["GST_PLUGIN_PATH"] = ":".join(os.path.join(gst_dir, d) for d in ("libav", "videoparsers"))
            cache = os.path.join(env.get("XDG_CACHE_HOME") or os.path.join(self.home, ".cache"), "pip-theater")
            os.makedirs(cache, exist_ok=True)
            env["GST_REGISTRY"] = os.path.join(cache, "gst-registry-check.bin")   # never touch the shared one
        except Exception as exc:
            out["bundle_error"] = str(exc)
        gst = _which("gst-inspect-1.0", env)
        out["gstreamer"] = bool(gst)
        for el in NEEDED_ELEMENTS:
            ok = False
            if gst:
                try:
                    p = await asyncio.create_subprocess_exec(gst, el, env=env, stdin=asyncio.subprocess.DEVNULL,
                                                             stdout=asyncio.subprocess.DEVNULL,
                                                             stderr=asyncio.subprocess.DEVNULL)
                    ok = (await asyncio.wait_for(p.wait(), 20)) == 0
                except Exception:
                    ok = False
            out["elements"][el] = ok
        out["ready"] = bool(gst) and all(out["elements"].values()) and bool(out["bundle"])
        self.log.info("mirror system check: %s", json.dumps(out))
        return out

    async def save_report(self, extra: str = "") -> Dict[str, Any]:
        """Everything useful for a bug report in one text file in ~/Downloads (no PIN, no secrets)."""
        try:
            check = await self.system_check()
        except Exception as exc:
            check = {"error": str(exc)}
        st = self.state()
        st.pop("player_url", None)
        st.pop("pin", None)
        lines = ["PiP Theater problem report", time.strftime("%Y-%m-%d %H:%M:%S"),
                 "", "== mirror state ==", json.dumps(st, indent=1, default=str),
                 "", "== system check ==", json.dumps(check, indent=1),
                 "", "== automatic restarts ==", "\n".join(self.recoveries) or "none",
                 "", "== receiver output (last lines) ==", "\n".join(self.rc_output[-60:]) or "none",
                 "", "== panel ==", str(extra)[:8000] or "none"]
        text = "\n".join(lines).replace(self.secret, "****")
        if self.pin:
            text = text.replace("-pin %s" % self.pin, "-pin ****")
        folder = os.path.join(self.home, "Downloads")
        try:
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, "pip-theater-report-%s.txt" % time.strftime("%Y%m%d-%H%M%S"))
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text + "\n")
        except OSError as exc:
            return {"ok": False, "message": "Could not save the report: %s" % exc}
        return {"ok": True, "message": "Saved to Downloads/" + os.path.basename(path), "path": path}
