"""
PiP Theater - Decky backend.

Responsibilities:
  * persist the plugin settings (sizes, positions, bookmarks, ...)
  * phone mirroring (backend/mirror.py): run the AirPlay receiver and feed its video to
    the PiP page
  * drive the "External browser" engine used for DRM sites (Netflix, Disney+, ...):
      - launch a Flatpak Chromium-based browser (Chrome / Edge / Brave ship Widevine)
      - start backend/overlay_helper.py, which turns that browser into a gamescope
        overlay floating above the game
      - expose the browser's DevTools endpoint so the frontend can control playback
        and mirror the page for logging in / picking a show
"""

import asyncio
import json
import os
import signal
import socket
import sys
import urllib.request

import decky  # provided by Decky Loader at runtime

PLUGIN_DIR = decky.DECKY_PLUGIN_DIR
sys.path.insert(0, os.path.join(PLUGIN_DIR, "backend"))

from mirror import DEFAULT_OPTIONS as MIRROR_DEFAULTS, Mirror, load_json  # noqa: E402
SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")
HELPER = os.path.join(PLUGIN_DIR, "backend", "overlay_helper.py")
WINDOW_CLASS = "PiPTheaterBrowser"
SYSTEM_PYTHON = "/usr/bin/python3"
FLATPAK = "/usr/bin/flatpak"

# Flatpak browsers that bundle (or auto-download) the Widevine CDM.
KNOWN_BROWSERS = [
    ("com.google.Chrome", "Google Chrome"),
    ("com.microsoft.Edge", "Microsoft Edge"),
    ("com.brave.Browser", "Brave"),
    ("org.chromium.Chromium", "Chromium (no DRM unless Widevine added)"),
]


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _flatpak_installed(app_id: str) -> bool:
    roots = [
        "/var/lib/flatpak/app",
        os.path.join(decky.DECKY_USER_HOME, ".local/share/flatpak/app"),
    ]
    return any(os.path.isdir(os.path.join(r, app_id, "current")) for r in roots)


def _read_environ(pid: str) -> dict:
    with open(f"/proc/{pid}/environ", "rb") as f:
        raw = f.read().split(b"\0")
    env = {}
    for item in raw:
        if b"=" in item:
            k, v = item.split(b"=", 1)
            env[k.decode(errors="ignore")] = v.decode(errors="ignore")
    return env


def _steam_environ() -> dict:
    """Environment of the running Steam client: the user's real desktop session."""
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/comm") as f:
                if f.read().strip() != "steam":
                    continue
            return _read_environ(pid)
        except (OSError, PermissionError):
            continue
    return {}


def _gamescope_display(uid: int):
    path = f"/run/user/{uid}/gamescope-environment"
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("export "):
                    line = line[len("export "):]
                if line.startswith("DISPLAY="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return None


def _session_env() -> dict:
    env = _steam_environ() or dict(os.environ)
    uid = os.getuid()
    env["HOME"] = decky.DECKY_USER_HOME
    env["USER"] = decky.DECKY_USER
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{uid}")
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{uid}/bus")
    env["DISPLAY"] = _gamescope_display(uid) or env.get("DISPLAY") or ":0"
    # Strip things that would leak Decky's / Steam's runtime into the browser.
    for key in ("LD_PRELOAD", "LD_LIBRARY_PATH", "WAYLAND_DISPLAY", "PYTHONHOME",
                "PYTHONPATH", "SteamAppId", "SteamGameId", "SteamOverlayGameId"):
        env.pop(key, None)
    return env


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _signal_group(pid: int, sig) -> None:
    try:
        os.killpg(os.getpgid(pid), sig)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def _http_json(url: str, timeout: float = 2.0):
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 (localhost only)
        return json.loads(resp.read().decode())


# --------------------------------------------------------------------------- #
# External browser engine
# --------------------------------------------------------------------------- #

class ExternalBrowser:
    def __init__(self):
        self.browser = None   # asyncio subprocess
        self.helper = None    # asyncio subprocess
        self.port = None
        self.screen = None    # (w, h) of the gamescope X screen
        self.rect = None      # last normalised rect from the frontend
        self.visible = True
        self._ready = asyncio.Event()
        self._tasks = []

    @property
    def running(self) -> bool:
        return self.browser is not None and self.browser.returncode is None

    async def start(self, url: str, browser_id: str, rect: dict) -> dict:
        await self.stop()
        if not os.path.exists(FLATPAK):
            return {"ok": False, "error": "Flatpak is not available on this system."}
        if not _flatpak_installed(browser_id):
            return {"ok": False, "error": f"{browser_id} is not installed. Install it from Discover in Desktop Mode."}

        env = _session_env()
        self.rect = rect
        self.visible = True
        self._ready = asyncio.Event()

        # 1) overlay helper (must exist before the browser maps its window)
        try:
            self.helper = await asyncio.create_subprocess_exec(
                SYSTEM_PYTHON, HELPER, WINDOW_CLASS,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, env=env)
        except OSError as exc:
            return {"ok": False, "error": f"Could not start overlay helper: {exc}"}
        self._tasks = [asyncio.create_task(self._read_helper()),
                       asyncio.create_task(self._log_stream(self.helper.stderr, "helper"))]
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=8)
        except asyncio.TimeoutError:
            await self.stop()
            return {"ok": False, "error": "Overlay helper did not start (is gamescope running?)."}
        if self.helper.returncode is not None:
            await self.stop()
            return {"ok": False, "error": "Overlay helper exited; see plugin log."}
        await self._push_rect()

        # 2) the browser itself
        self.port = _free_port()
        profile = os.path.join(decky.DECKY_USER_HOME, ".var", "app", browser_id, "pip-theater-profile")
        os.makedirs(profile, exist_ok=True)
        w, h = self._pixel_size()
        args = [
            FLATPAK, "run", browser_id,
            f"--user-data-dir={profile}",
            f"--class={WINDOW_CLASS}",
            f"--app={url}",
            f"--window-size={w},{h}",
            "--window-position=0,0",
            f"--remote-debugging-port={self.port}",
            "--remote-debugging-address=127.0.0.1",
            "--remote-allow-origins=*",
            "--ozone-platform=x11",
            "--password-store=basic",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-session-crashed-bubble",
            "--hide-crash-restore-bubble",
            "--autoplay-policy=no-user-gesture-required",
            "--disable-features=Translate,MediaRouter",
        ]
        try:
            self.browser = await asyncio.create_subprocess_exec(
                *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE, env=env, start_new_session=True)
        except OSError as exc:
            await self.stop()
            return {"ok": False, "error": f"Could not launch browser: {exc}"}
        self._tasks += [asyncio.create_task(self._log_stream(self.browser.stderr, "browser")),
                        asyncio.create_task(self._watch_browser())]
        decky.logger.info(f"External browser started: {browser_id} port={self.port}")
        return {"ok": True, "port": self.port}

    def _pixel_size(self):
        sw, sh = self.screen or (1280, 800)
        r = self.rect or {"w": 0.4, "h": 0.4}
        return max(200, int(r["w"] * sw)), max(120, int(r["h"] * sh))

    async def _send(self, obj: dict):
        if self.helper is None or self.helper.returncode is not None or self.helper.stdin is None:
            return
        try:
            self.helper.stdin.write((json.dumps(obj) + "\n").encode())
            await self.helper.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass

    async def _push_rect(self):
        if not self.rect or not self.screen:
            return
        sw, sh = self.screen
        r = self.rect
        await self._send({"cmd": "rect", "x": round(r["x"] * sw), "y": round(r["y"] * sh),
                          "w": max(1, round(r["w"] * sw)), "h": max(1, round(r["h"] * sh))})

    async def set_rect(self, rect: dict):
        self.rect = rect
        await self._push_rect()

    async def set_visible(self, visible: bool):
        self.visible = visible
        await self._send({"cmd": "visible", "value": bool(visible)})

    async def _read_helper(self):
        assert self.helper and self.helper.stdout
        async for line in self.helper.stdout:
            try:
                msg = json.loads(line.decode())
            except ValueError:
                continue
            ev = msg.get("event")
            if ev == "ready":
                self.screen = (msg["width"], msg["height"])
                self._ready.set()
            elif ev in ("warning", "error"):
                decky.logger.warning(f"overlay helper: {msg.get('message')}")
                await decky.emit("pip_external_status", ev, msg.get("message", ""))
            elif ev == "attached":
                await decky.emit("pip_external_status", "attached", "")
            elif ev == "detached":
                await decky.emit("pip_external_status", "detached", "")
        self._ready.set()

    async def _log_stream(self, stream, name):
        if stream is None:
            return
        async for line in stream:
            text = line.decode(errors="ignore").rstrip()
            if text:
                decky.logger.debug(f"[{name}] {text}")

    async def _watch_browser(self):
        proc = self.browser
        if proc is None:
            return
        code = await proc.wait()
        if proc is self.browser:
            decky.logger.info(f"External browser exited with code {code}")
            await decky.emit("pip_external_status", "exited", str(code))
            await self.stop()

    async def stop(self):
        browser, helper = self.browser, self.helper
        self.browser = self.helper = None
        self.port = None
        if helper is not None and helper.returncode is None:
            try:
                helper.stdin.write(b'{"cmd":"quit"}\n')
                await helper.stdin.drain()
                await asyncio.wait_for(helper.wait(), timeout=2)
            except Exception:  # noqa: BLE001
                helper.kill()
        if browser is not None and browser.returncode is None:
            # The browser runs in its own process group (start_new_session) so we can
            # stop flatpak + every browser child without touching other Chrome windows.
            _signal_group(browser.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(browser.wait(), timeout=5)
            except asyncio.TimeoutError:
                _signal_group(browser.pid, signal.SIGKILL)
        for t in self._tasks:
            if t is not asyncio.current_task():
                t.cancel()
        self._tasks = []

    def targets(self):
        if not self.port:
            return []
        try:
            return _http_json(f"http://127.0.0.1:{self.port}/json/list")
        except Exception:  # noqa: BLE001 (browser still booting)
            return []


# --------------------------------------------------------------------------- #
# Plugin API (called from the frontend via @decky/api `callable`)
# --------------------------------------------------------------------------- #

def _plugin_version() -> str:
    data = load_json(os.path.join(PLUGIN_DIR, "package.json"), {})
    return str(data.get("version", "0")) if isinstance(data, dict) else "0"


def _stored_mirror_options() -> dict:
    """The mirror options as last saved by the panel (so the receiver starts with Steam)."""
    data = load_json(SETTINGS_FILE, {})
    opts = data.get("mirror") if isinstance(data, dict) else None
    return opts if isinstance(opts, dict) else dict(MIRROR_DEFAULTS)


class Plugin:
    external: ExternalBrowser
    mirror: Mirror

    async def get_settings(self):
        try:
            with open(SETTINGS_FILE) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    async def save_settings(self, settings: dict):
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(settings, f, indent=2)
        os.replace(tmp, SETTINGS_FILE)
        return True

    # ---- phone mirroring -------------------------------------------------- #

    async def mirror_state(self):
        return self.mirror.state()

    async def mirror_configure(self, options: dict):
        return await self.mirror.configure(options)

    async def mirror_retry(self):
        return await self.mirror.retry()

    async def mirror_forget_phones(self):
        return await self.mirror.forget_phones()

    async def mirror_check(self):
        return await self.mirror.system_check()

    async def mirror_report(self, extra: str = ""):
        return await self.mirror.save_report(extra)

    # ---- external browser (DRM sites) ------------------------------------- #

    async def list_browsers(self):
        return [{"id": i, "name": n} for i, n in KNOWN_BROWSERS if _flatpak_installed(i)]

    async def external_start(self, url: str, browser_id: str, rect: dict):
        return await self.external.start(url, browser_id, rect)

    async def external_set_rect(self, rect: dict):
        await self.external.set_rect(rect)

    async def external_set_visible(self, visible: bool):
        await self.external.set_visible(visible)

    async def external_stop(self):
        await self.external.stop()

    async def external_status(self):
        return {"running": self.external.running, "port": self.external.port,
                "screen": list(self.external.screen) if self.external.screen else None}

    async def cdp_targets(self):
        return await asyncio.get_running_loop().run_in_executor(None, self.external.targets)

    async def log(self, level: str, message: str):
        getattr(decky.logger, level if level in ("info", "warning", "error") else "info")(f"[ui] {message}")

    # ---- lifecycle -------------------------------------------------------- #

    async def _main(self):
        self.external = ExternalBrowser()
        self.mirror = Mirror(plugin_dir=PLUGIN_DIR, settings_dir=decky.DECKY_PLUGIN_SETTINGS_DIR,
                             home=decky.DECKY_USER_HOME, user=decky.DECKY_USER, log=decky.logger,
                             version=_plugin_version())
        try:
            await self.mirror.start(_stored_mirror_options())
        except Exception as exc:  # noqa: BLE001 (streaming sites must keep working regardless)
            self.mirror.start_error = f"Phone mirroring could not start: {exc}"
            decky.logger.exception("mirror start failed")
        decky.logger.info("PiP Theater backend loaded")

    async def _unload(self):
        await self.mirror.stop()
        await self.external.stop()
        decky.logger.info("PiP Theater backend unloaded")

    async def _uninstall(self):
        pass
