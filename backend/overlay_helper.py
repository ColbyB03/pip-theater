#!/usr/bin/env python3
"""
PiP Theater - gamescope overlay helper.

Runs as a separate process (system /usr/bin/python3, outside Decky's bundled
interpreter) so it can talk to the gamescope Xwayland server with plain libX11
through ctypes. No third-party packages are needed.

How it works
------------
gamescope composites exactly one "external overlay" window on top of whatever
game is focused. A window becomes that overlay when it carries the X11 property
GAMESCOPE_EXTERNAL_OVERLAY=1. gamescope draws the overlay at full-screen size
from the top-left corner and never gives it input focus.

So this helper:
  1. creates a full-screen, fully transparent (32-bit ARGB), override-redirect
     window and marks it as the external overlay;
  2. waits for the browser's top-level window (found by its WM_CLASS) and
     re-parents it into the transparent window at the requested position;
  3. moves/resizes that child whenever the plugin asks.

Everything outside the browser rectangle stays transparent, so the game shows
through and the browser looks like a floating picture-in-picture window.

Protocol: one JSON object per line.
  stdin  -> {"cmd": "rect", "x": int, "y": int, "w": int, "h": int}
            {"cmd": "visible", "value": bool}
            {"cmd": "quit"}
  stdout <- {"event": "ready", "width": int, "height": int}
            {"event": "attached", "window": int}
            {"event": "detached"}
            {"event": "warning" | "error", "message": str}
"""

import ctypes
import ctypes.util
import json
import os
import select
import sys
import time

WINDOW_CLASS = sys.argv[1] if len(sys.argv) > 1 else "PiPTheaterBrowser"

# --------------------------------------------------------------------------- #
# libX11 bindings (only what we need)
# --------------------------------------------------------------------------- #

c_ulong = ctypes.c_ulong
Window = c_ulong
Atom = c_ulong
Colormap = c_ulong
VisualID = c_ulong
Pixmap = c_ulong
Cursor = c_ulong


class XVisualInfo(ctypes.Structure):
    _fields_ = [
        ("visual", ctypes.c_void_p),
        ("visualid", VisualID),
        ("screen", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("c_class", ctypes.c_int),
        ("red_mask", c_ulong),
        ("green_mask", c_ulong),
        ("blue_mask", c_ulong),
        ("colormap_size", ctypes.c_int),
        ("bits_per_rgb", ctypes.c_int),
    ]


class XSetWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("background_pixmap", Pixmap),
        ("background_pixel", c_ulong),
        ("border_pixmap", Pixmap),
        ("border_pixel", c_ulong),
        ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", c_ulong),
        ("backing_pixel", c_ulong),
        ("save_under", ctypes.c_int),
        ("event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("colormap", Colormap),
        ("cursor", Cursor),
    ]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("border_width", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p),
        ("root", Window),
        ("c_class", ctypes.c_int),
        ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", c_ulong),
        ("backing_pixel", c_ulong),
        ("save_under", ctypes.c_int),
        ("colormap", Colormap),
        ("map_installed", ctypes.c_int),
        ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long),
        ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


class XClassHint(ctypes.Structure):
    _fields_ = [("res_name", ctypes.c_char_p), ("res_class", ctypes.c_char_p)]


class XErrorEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("resourceid", c_ulong),
        ("serial", c_ulong),
        ("error_code", ctypes.c_ubyte),
        ("request_code", ctypes.c_ubyte),
        ("minor_code", ctypes.c_ubyte),
    ]


# X constants
InputOutput = 1
TrueColor = 4
AllocNone = 0
CWBackPixel = 1 << 1
CWBorderPixel = 1 << 3
CWOverrideRedirect = 1 << 9
CWColormap = 1 << 13
XA_CARDINAL = 6
PropModeReplace = 0
IsViewable = 2
ShapeInput = 2
ShapeSet = 0
Unsorted = 0


def emit(event, **data):
    data["event"] = event
    sys.stdout.write(json.dumps(data) + "\n")
    sys.stdout.flush()


def load_lib(name):
    path = ctypes.util.find_library(name)
    candidates = [path] if path else []
    candidates += [f"lib{name}.so.6", f"/usr/lib/lib{name}.so.6"]
    for c in candidates:
        try:
            return ctypes.CDLL(c)
        except OSError:
            continue
    return None


x11 = load_lib("X11")
if x11 is None:
    emit("error", message="libX11 not found")
    sys.exit(1)
xext = load_lib("Xext")  # optional: used to make the overlay click-through

x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
x11.XRootWindow.restype = Window
x11.XRootWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XMatchVisualInfo.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                 ctypes.POINTER(XVisualInfo)]
x11.XCreateColormap.restype = Colormap
x11.XCreateColormap.argtypes = [ctypes.c_void_p, Window, ctypes.c_void_p, ctypes.c_int]
x11.XCreateWindow.restype = Window
x11.XCreateWindow.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                              ctypes.c_uint, ctypes.c_uint, ctypes.c_int, ctypes.c_uint,
                              ctypes.c_void_p, c_ulong, ctypes.POINTER(XSetWindowAttributes)]
x11.XInternAtom.restype = Atom
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XChangeProperty.argtypes = [ctypes.c_void_p, Window, Atom, Atom, ctypes.c_int, ctypes.c_int,
                                ctypes.c_void_p, ctypes.c_int]
x11.XStoreName.argtypes = [ctypes.c_void_p, Window, ctypes.c_char_p]
x11.XMapWindow.argtypes = [ctypes.c_void_p, Window]
x11.XMapRaised.argtypes = [ctypes.c_void_p, Window]
x11.XUnmapWindow.argtypes = [ctypes.c_void_p, Window]
x11.XDestroyWindow.argtypes = [ctypes.c_void_p, Window]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XQueryTree.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(Window), ctypes.POINTER(Window),
                           ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint)]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XGetClassHint.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XClassHint)]
x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XWindowAttributes)]
x11.XReparentWindow.argtypes = [ctypes.c_void_p, Window, Window, ctypes.c_int, ctypes.c_int]
x11.XMoveResizeWindow.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int,
                                  ctypes.c_uint, ctypes.c_uint]
x11.XPending.argtypes = [ctypes.c_void_p]
x11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]

# Xlib's default error handler kills the process (e.g. on BadWindow when the
# browser closes a window we were looking at). Install a forgiving one.
ERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(XErrorEvent))
_last_error = {"code": 0}


def _on_x_error(_display, event):
    _last_error["code"] = event.contents.error_code
    return 0


_error_handler_ref = ERROR_HANDLER(_on_x_error)
x11.XSetErrorHandler(_error_handler_ref)


# --------------------------------------------------------------------------- #
# Overlay logic
# --------------------------------------------------------------------------- #

class Overlay:
    def __init__(self):
        display_name = os.environ.get("DISPLAY", ":0").encode()
        self.dpy = x11.XOpenDisplay(display_name)
        if not self.dpy:
            emit("error", message=f"Cannot open X display {display_name.decode()}")
            sys.exit(1)
        self.screen = x11.XDefaultScreen(self.dpy)
        self.root = x11.XRootWindow(self.dpy, self.screen)
        self.width = x11.XDisplayWidth(self.dpy, self.screen)
        self.height = x11.XDisplayHeight(self.dpy, self.screen)
        self.child = None
        self.visible = True
        self.rect = (0, 0, max(320, self.width // 3), max(180, self.height // 3))
        self.window = self._create_overlay_window()

    def _create_overlay_window(self):
        vinfo = XVisualInfo()
        if not x11.XMatchVisualInfo(self.dpy, self.screen, 32, TrueColor, ctypes.byref(vinfo)):
            emit("error", message="No 32-bit ARGB visual available")
            sys.exit(1)

        attrs = XSetWindowAttributes()
        attrs.colormap = x11.XCreateColormap(self.dpy, self.root, vinfo.visual, AllocNone)
        attrs.background_pixel = 0  # fully transparent
        attrs.border_pixel = 0
        attrs.override_redirect = 1
        mask = CWColormap | CWBackPixel | CWBorderPixel | CWOverrideRedirect

        win = x11.XCreateWindow(self.dpy, self.root, 0, 0, self.width, self.height, 0,
                                vinfo.depth, InputOutput, vinfo.visual, mask, ctypes.byref(attrs))
        x11.XStoreName(self.dpy, win, b"PiP Theater overlay")

        # Make the overlay click-through so it can never swallow input.
        if xext is not None:
            try:
                xext.XShapeCombineRectangles.argtypes = [ctypes.c_void_p, Window, ctypes.c_int,
                                                         ctypes.c_int, ctypes.c_int, ctypes.c_void_p,
                                                         ctypes.c_int, ctypes.c_int, ctypes.c_int]
                xext.XShapeCombineRectangles(self.dpy, win, ShapeInput, 0, 0, None, 0, ShapeSet, Unsorted)
            except AttributeError:
                pass

        self._set_overlay_atom(win, 1)
        x11.XMapRaised(self.dpy, win)
        x11.XSync(self.dpy, 0)
        return win

    def _set_overlay_atom(self, win, value):
        atom = x11.XInternAtom(self.dpy, b"GAMESCOPE_EXTERNAL_OVERLAY", 0)
        # Xlib expects format-32 property data as an array of C longs.
        val = c_ulong(value)
        x11.XChangeProperty(self.dpy, win, atom, XA_CARDINAL, 32, PropModeReplace,
                            ctypes.byref(val), 1)

    # ---- browser window discovery ----------------------------------------- #

    def _children(self, win):
        root_ret, parent_ret = Window(), Window()
        children = ctypes.POINTER(Window)()
        count = ctypes.c_uint()
        if not x11.XQueryTree(self.dpy, win, ctypes.byref(root_ret), ctypes.byref(parent_ret),
                              ctypes.byref(children), ctypes.byref(count)):
            return []
        result = [children[i] for i in range(count.value)]
        if children:
            x11.XFree(children)
        return result

    def _class_matches(self, win):
        hint = XClassHint()
        if not x11.XGetClassHint(self.dpy, win, ctypes.byref(hint)):
            return False
        names = [hint.res_name or b"", hint.res_class or b""]
        # ctypes copies c_char_p values to Python bytes; the X-allocated strings leak a
        # few bytes per probe, which is fine for a short-lived helper polling a handful of windows.
        wanted = WINDOW_CLASS.lower().encode()
        return any(n.lower() == wanted for n in names)

    def _attrs(self, win):
        a = XWindowAttributes()
        if not x11.XGetWindowAttributes(self.dpy, win, ctypes.byref(a)):
            return None
        return a

    def find_browser_window(self):
        best, best_area = None, 0
        # Top-level windows, plus one level down in case something wrapped them.
        candidates = []
        for w in self._children(self.root):
            if w == self.window:
                continue
            candidates.append(w)
            candidates.extend(self._children(w))
        for w in candidates:
            if not self._class_matches(w):
                continue
            a = self._attrs(w)
            if a is None or a.map_state != IsViewable or a.width < 50 or a.height < 50:
                continue
            area = a.width * a.height
            if area > best_area:
                best, best_area = w, area
        return best

    def attach(self, win):
        x, y, w, h = self._effective_rect()
        x11.XReparentWindow(self.dpy, win, self.window, x, y)
        x11.XMoveResizeWindow(self.dpy, win, x, y, w, h)
        x11.XMapWindow(self.dpy, win)
        x11.XSync(self.dpy, 0)
        self.child = win
        emit("attached", window=int(win))

    # ---- geometry --------------------------------------------------------- #

    def _effective_rect(self):
        x, y, w, h = self.rect
        if not self.visible:
            # Keep the browser mapped (so it keeps playing audio and rendering
            # for the remote-control view) but park it outside the overlay.
            x = self.width + 50
        return x, y, w, h

    def apply(self):
        if self.child is None:
            return
        x, y, w, h = self._effective_rect()
        x11.XMoveResizeWindow(self.dpy, self.child, x, y, max(1, w), max(1, h))
        x11.XFlush(self.dpy)

    def check_child(self):
        if self.child is None:
            return
        a = self._attrs(self.child)
        if a is None:
            self.child = None
            emit("detached")
            return
        x, y, w, h = self._effective_rect()
        # The browser sometimes resizes/moves itself (e.g. fullscreen video). Put it back.
        if (a.x, a.y, a.width, a.height) != (x, y, w, h):
            self.apply()

    def drain_events(self):
        buf = ctypes.create_string_buffer(256)  # XEvent is 192 bytes on 64-bit
        while x11.XPending(self.dpy):
            x11.XNextEvent(self.dpy, buf)

    def close(self):
        try:
            self._set_overlay_atom(self.window, 0)
            x11.XDestroyWindow(self.dpy, self.window)
            x11.XSync(self.dpy, 0)
            x11.XCloseDisplay(self.dpy)
        except Exception:
            pass


def handle(overlay, msg):
    cmd = msg.get("cmd")
    if cmd == "rect":
        overlay.rect = (int(msg["x"]), int(msg["y"]), int(msg["w"]), int(msg["h"]))
        overlay.apply()
    elif cmd == "visible":
        overlay.visible = bool(msg.get("value", True))
        overlay.apply()
    elif cmd == "quit":
        return False
    return True


def main():
    overlay = Overlay()
    emit("ready", width=overlay.width, height=overlay.height)

    last_search = 0.0
    warned = False
    started = time.time()
    running = True
    stdin_fd = sys.stdin.fileno()
    pending = b""

    while running:
        readable, _, _ = select.select([stdin_fd], [], [], 0.1)
        if readable:
            chunk = os.read(stdin_fd, 65536)
            if not chunk:  # parent went away
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    running = handle(overlay, json.loads(line))
                except Exception as exc:  # noqa: BLE001
                    emit("warning", message=f"bad command: {exc}")
                if not running:
                    break

        now = time.time()
        if overlay.child is None and now - last_search > 0.1:
            last_search = now
            win = overlay.find_browser_window()
            if win:
                overlay.attach(win)
            elif not warned and now - started > 45:
                warned = True
                emit("warning", message="Browser window not found yet")
        else:
            overlay.check_child()

        overlay.drain_events()

    overlay.close()


if __name__ == "__main__":
    main()
