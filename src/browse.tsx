import { DialogButton, Focusable, Navigation, TextField } from "@decky/ui";
import { CSSProperties, PointerEvent, useEffect, useRef, useState, WheelEvent } from "react";
import { FaArrowLeft, FaCheck, FaPlay, FaRedo } from "react-icons/fa";
import { CdpClient, connectToPage } from "./cdp";
import * as player from "./player";
import { runtime } from "./player";
import { useStore } from "./store";

const page: CSSProperties = {
  position: "absolute",
  inset: 0,
  paddingTop: 48,
  paddingBottom: 44,
  display: "flex",
  flexDirection: "column",
  background: "#0e141b",
  color: "white",
  boxSizing: "border-box",
};

const btn: CSSProperties = {
  minWidth: 0,
  width: "auto",
  padding: "6px 14px",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

function Toolbar({ extra }: { extra?: React.ReactNode }) {
  const rt = useStore(runtime);
  const [url, setUrl] = useState(rt.url);
  useEffect(() => setUrl(rt.url), [rt.url]);

  return (
    <Focusable
      style={{ display: "flex", gap: 6, padding: "0 12px 8px", alignItems: "center" }}
      flow-children="horizontal"
    >
      <DialogButton style={btn} onClick={() => player.goBack()}>
        <FaArrowLeft />
      </DialogButton>
      <DialogButton style={btn} onClick={() => player.reload()}>
        <FaRedo />
      </DialogButton>
      <div style={{ flex: 1 }}>
        <TextField value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <DialogButton style={btn} onClick={() => player.navigate(url)}>
        Go
      </DialogButton>
      {extra}
      <DialogButton style={btn} onClick={() => player.command({ type: "toggle" })}>
        <FaPlay />
      </DialogButton>
      <DialogButton style={btn} onClick={() => Navigation.NavigateBack()}>
        <FaCheck /> Done
      </DialogButton>
    </Focusable>
  );
}

/** Built-in engine: the real browser view is moved over this page and focused. */
function BuiltinBrowse() {
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const measure = () => {
      const r = area.current?.getBoundingClientRect();
      if (!r) return;
      runtime.set({
        browsing: true,
        browseRect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      });
    };
    measure();
    const t = setInterval(measure, 500);
    return () => {
      clearInterval(t);
      runtime.set({ browsing: false, browseRect: null });
    };
  }, []);

  return (
    <div style={page}>
      <Toolbar />
      <div ref={area} style={{ flex: 1, margin: "0 12px", background: "#000" }} />
    </div>
  );
}

const KEYS: { label: string; key: string; code: string; vk: number; text?: string }[] = [
  { label: "Enter", key: "Enter", code: "Enter", vk: 13, text: "\r" },
  { label: "⌫", key: "Backspace", code: "Backspace", vk: 8 },
  { label: "Tab", key: "Tab", code: "Tab", vk: 9 },
  { label: "Esc", key: "Escape", code: "Escape", vk: 27 },
  { label: "Space", key: " ", code: "Space", vk: 32, text: " " },
  { label: "←", key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  { label: "→", key: "ArrowRight", code: "ArrowRight", vk: 39 },
  { label: "↑", key: "ArrowUp", code: "ArrowUp", vk: 38 },
  { label: "↓", key: "ArrowDown", code: "ArrowDown", vk: 40 },
];

/**
 * External engine: the browser lives outside Steam, so we mirror it with the
 * DevTools screencast and forward taps, scrolling and typing to it.
 * (DRM video itself shows black in the mirror - that's expected; it plays fine in the PiP.)
 */
function ExternalBrowse() {
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting to the browser…");
  const [text, setText] = useState("");
  const cdp = useRef<CdpClient | null>(null);
  const meta = useRef({ w: 1280, h: 800 });
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    runtime.set({ browsing: true });
    let alive = true;
    connectToPage(15000)
      .then(async (c) => {
        if (!alive) return c.close();
        cdp.current = c;
        c.on("Page.screencastFrame", (p) => {
          setFrame("data:image/jpeg;base64," + p.data);
          if (p.metadata?.deviceWidth) meta.current = { w: p.metadata.deviceWidth, h: p.metadata.deviceHeight };
          c.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
        });
        await c.send("Page.enable");
        await c.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 800 });
        setStatus("");
      })
      .catch((e) => setStatus("Could not connect to the browser: " + (e?.message || e)));
    return () => {
      alive = false;
      cdp.current?.send("Page.stopScreencast").catch(() => undefined);
      cdp.current?.close();
      cdp.current = null;
      runtime.set({ browsing: false });
    };
  }, []);

  const toPage = (e: { clientX: number; clientY: number }) => {
    const r = img.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * meta.current.w,
      y: ((e.clientY - r.top) / r.height) * meta.current.h,
    };
  };

  const send = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    cdp.current?.send("Input.dispatchMouseEvent", { type, x, y, ...extra }).catch(() => undefined);

  // Touchscreen (and mouse) on the picture: a short press is a tap on the page, a drag scrolls it
  // like on a phone. The press is only sent to the page on release, once we know it was no drag.
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);

  const down = (e: PointerEvent<HTMLImageElement>) => {
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable: dragging still works while the finger stays on the picture */
    }
  };

  const move = (e: PointerEvent<HTMLImageElement>) => {
    const d = drag.current;
    const { x, y } = toPage(e);
    if (!d || d.id !== e.pointerId) {
      send("mouseMoved", x, y);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 12) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    const r = img.current!.getBoundingClientRect();
    send("mouseWheel", x, y, { deltaX: (-dx / r.width) * meta.current.w, deltaY: (-dy / r.height) * meta.current.h });
  };

  const up = (e: PointerEvent<HTMLImageElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || d.moved) return;
    const { x, y } = toPage(e);
    send("mouseMoved", x, y);
    send("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
    send("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
  };

  const wheel = (e: WheelEvent) => {
    const { x, y } = toPage(e);
    cdp.current
      ?.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY })
      .catch(() => undefined);
  };

  const scroll = (dy: number) =>
    cdp.current
      ?.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: meta.current.w / 2, y: meta.current.h / 2, deltaX: 0, deltaY: dy })
      .catch(() => undefined);

  const key = async (k: (typeof KEYS)[number]) => {
    const c = cdp.current;
    if (!c) return;
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: k.text }).catch(() => undefined);
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }).catch(() => undefined);
  };

  const typeText = () => {
    if (!text) return;
    cdp.current?.send("Input.insertText", { text }).catch(() => undefined);
    setText("");
  };

  return (
    <div style={page}>
      <Toolbar />
      <div
        style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center", alignItems: "center", margin: "0 12px", background: "#000" }}
      >
        {frame ? (
          <img
            ref={img}
            src={frame}
            draggable={false}
            style={{ maxWidth: "100%", maxHeight: "100%", userSelect: "none", touchAction: "none" }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => (drag.current = null)}
            onWheel={wheel}
          />
        ) : (
          <div style={{ opacity: 0.7 }}>{status || "Waiting for the page…"}</div>
        )}
      </div>
      <Focusable style={{ display: "flex", gap: 6, padding: "8px 12px 0", alignItems: "center" }} flow-children="horizontal">
        <div style={{ flex: 1 }}>
          <TextField value={text} placeholder="Type text for the page…" onChange={(e) => setText(e.target.value)} />
        </div>
        <DialogButton style={btn} onClick={typeText}>
          Type
        </DialogButton>
        {KEYS.map((k) => (
          <DialogButton key={k.label} style={btn} onClick={() => key(k)}>
            {k.label}
          </DialogButton>
        ))}
        <DialogButton style={btn} onClick={() => scroll(-400)}>
          Scroll ▲
        </DialogButton>
        <DialogButton style={btn} onClick={() => scroll(400)}>
          Scroll ▼
        </DialogButton>
      </Focusable>
    </div>
  );
}

export function BrowsePage() {
  const rt = useStore(runtime);
  if (!rt.active) {
    return (
      <div style={{ ...page, justifyContent: "center", alignItems: "center" }}>
        <div>Nothing is playing. Start something from PiP Theater in the Quick Access menu.</div>
        <DialogButton style={{ ...btn, marginTop: 16 }} onClick={() => Navigation.NavigateBack()}>
          Back
        </DialogButton>
      </div>
    );
  }
  return rt.engine === "builtin" ? <BuiltinBrowse /> : <ExternalBrowse />;
}
