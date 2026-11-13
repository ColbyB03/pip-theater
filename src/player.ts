import { addEventListener, callable, removeEventListener, toaster } from "@decky/api";
import { CdpClient, connectToPage } from "./cdp";
import { steamSupportsWidevine } from "./drm";
import { computeRect, hiddenByMenu, Rect, Size } from "./geometry";
import { MediaCommand, mediaScript } from "./media";
import { settings } from "./settings";
import { Engine, EngineChoice, normalizeUrl, resolveEngine } from "./sites";
import { openMenu, overlay, SteamView, uiScreen } from "./steam";
import { Store } from "./store";

// --------------------------------------------------------------------------- //
// Runtime state (not persisted)
// --------------------------------------------------------------------------- //

export interface BrowserInfo {
  id: string;
  name: string;
}

export interface Runtime {
  active: boolean;
  engine: Engine | null;
  url: string;
  status: "idle" | "starting" | "playing" | "error";
  message: string;
  /** User pressed "Hide": the window is parked off-screen but audio keeps going. */
  hidden: boolean;
  /** The full-screen Browse & Control page is open. */
  browsing: boolean;
  /** Where the built-in view should sit while browsing (Steam UI pixels). */
  browseRect: Rect | null;
  steamWidevine: boolean | null;
  browsers: BrowserInfo[];
}

export const runtime = new Store<Runtime>({
  active: false,
  engine: null,
  url: "",
  status: "idle",
  message: "",
  hidden: false,
  browsing: false,
  browseRect: null,
  steamWidevine: null,
  browsers: [],
});

const listBrowsers = callable<[], BrowserInfo[]>("list_browsers");
const externalStart = callable<
  [url: string, browserId: string, rect: NormRect],
  { ok: boolean; error?: string; port?: number }
>("external_start");
const externalSetRect = callable<[rect: NormRect], void>("external_set_rect");
const externalSetVisible = callable<[visible: boolean], void>("external_set_visible");
const externalStop = callable<[], void>("external_stop");
export const backendLog = callable<[level: string, message: string], void>("log");

interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// --------------------------------------------------------------------------- //
// Engines
// --------------------------------------------------------------------------- //

interface PlayerEngine {
  readonly kind: Engine;
  start(url: string, initial: NormRect): Promise<void>;
  navigate(url: string): void;
  layout(rect: Rect, screen: Size, visible: boolean, focus: boolean): void;
  run(script: string): void;
  back(): void;
  reload(): void;
  stop(): Promise<void>;
}

/** Steam's own embedded browser view. Fast and fully integrated, but no Widevine DRM. */
class BuiltinEngine implements PlayerEngine {
  readonly kind = "builtin" as const;
  private view = new SteamView("pip-theater");

  async start(url: string) {
    if (!this.view.create()) throw new Error(this.view.error || "Steam's browser view is not available.");
    this.view.load(url);
  }

  navigate(url: string) {
    this.view.navigate(url);
  }

  layout(rect: Rect, _screen: Size, visible: boolean, focus: boolean) {
    this.view.layout(rect, visible, focus);
  }

  run(script: string) {
    this.view.run(script);
  }

  back() {
    this.view.back();
  }

  reload() {
    this.view.reload();
  }

  async stop() {
    this.view.destroy();
  }
}

/**
 * A real Chrome/Edge/Brave (Flatpak) shown above the game as a gamescope overlay.
 * These browsers include Widevine, so Netflix, Disney+ etc. work.
 */
class ExternalEngine implements PlayerEngine {
  readonly kind = "external" as const;
  private cdp: CdpClient | null = null;
  private connecting: Promise<void> | null = null;
  private lastRect = "";
  private lastVisible: boolean | null = null;

  constructor(private browserId: string) {}

  async start(url: string, initial: NormRect) {
    const res = await externalStart(url, this.browserId, initial);
    if (!res.ok) throw new Error(res.error || "Could not start the external browser.");
    this.ensureConnected();
  }

  private ensureConnected() {
    if ((this.cdp && !this.cdp.closed) || this.connecting) return;
    this.connecting = connectToPage(45000)
      .then((c) => {
        this.cdp = c;
        c.onClose = () => {
          if (this.cdp === c) this.cdp = null;
        };
      })
      .catch((e) => {
        console.warn("[PiP Theater] DevTools connection failed", e);
      })
      .finally(() => {
        this.connecting = null;
      });
  }

  navigate(url: string) {
    this.ensureConnected();
    this.cdp?.send("Page.navigate", { url }).catch(console.error);
  }

  layout(rect: Rect, screen: Size, visible: boolean) {
    const norm: NormRect = {
      x: rect.x / screen.w,
      y: rect.y / screen.h,
      w: rect.width / screen.w,
      h: rect.height / screen.h,
    };
    const key = JSON.stringify(norm);
    if (key !== this.lastRect) {
      this.lastRect = key;
      externalSetRect(norm).catch(console.error);
    }
    if (visible !== this.lastVisible) {
      this.lastVisible = visible;
      externalSetVisible(visible).catch(console.error);
    }
  }

  run(script: string) {
    this.ensureConnected();
    this.cdp?.evaluate(script).catch(() => undefined);
  }

  back() {
    this.run("history.back();");
  }

  reload() {
    this.cdp?.send("Page.reload", {}).catch(console.error);
  }

  async stop() {
    this.cdp?.close();
    this.cdp = null;
    await externalStop();
  }
}

// --------------------------------------------------------------------------- //
// Controller
// --------------------------------------------------------------------------- //

let engine: PlayerEngine | null = null;
let timers: ReturnType<typeof setInterval>[] = [];
let unsubscribers: (() => void)[] = [];
let statusListener: ((...args: any[]) => void) | null = null;
let lastFill: boolean | null = null;

function normRect(rect: Rect, screen: Size): NormRect {
  return { x: rect.x / screen.w, y: rect.y / screen.h, w: rect.width / screen.w, h: rect.height / screen.h };
}

export function applyLayout() {
  if (!engine) {
    overlay.set({ site: false });
    return;
  }
  const rt = runtime.get();
  const s = settings.get();
  const screen = uiScreen();

  if (rt.browsing) {
    // The Browse page is a full Steam page: Steam's UI is in front anyway, no overlay needed.
    overlay.set({ site: false });
    if (engine.kind === "builtin" && rt.browseRect) {
      engine.layout(rt.browseRect, screen, true, true);
    } else {
      // External: give the page a full-size window (for a legible mirror) but keep it parked.
      engine.layout({ x: 0, y: 0, width: screen.w, height: screen.h }, screen, false, false);
    }
    return;
  }

  const menu = openMenu();
  const rect = computeRect(s, screen, menu);
  const visible = !rt.hidden && !hiddenByMenu(s.menuBehavior, menu);
  engine.layout(rect, screen, visible, false);
  // Steam's own view needs Steam's UI layer drawn over the game; the external browser is its own overlay.
  overlay.set({ site: engine.kind === "builtin" && visible });
}

function applyMediaState(force = false) {
  if (!engine) return;
  const s = settings.get();
  engine.run(mediaScript({ type: "volume", volume: s.volume / 100, muted: s.muted }));
  if (force || s.fillVideo || lastFill !== s.fillVideo) {
    lastFill = s.fillVideo;
    engine.run(mediaScript({ type: "fill", enabled: s.fillVideo }));
  }
}

export async function play(rawUrl: string, choice?: EngineChoice) {
  const url = normalizeUrl(rawUrl);
  if (!url) return;
  const s = settings.get();
  const kind = resolveEngine(url, choice ?? s.engineChoice, runtime.get().steamWidevine === true);

  if (engine && engine.kind === kind && runtime.get().active) {
    engine.navigate(url);
    runtime.set({ url, hidden: false });
    settings.set({ lastUrl: url, wasPlaying: true });
    return;
  }

  await stopEngine();
  runtime.set({ status: "starting", message: "", url, engine: kind });
  const next: PlayerEngine = kind === "builtin" ? new BuiltinEngine() : new ExternalEngine(s.externalBrowser);
  try {
    const screen = uiScreen();
    await next.start(url, normRect(computeRect(s, screen, "none"), screen));
    engine = next;
    lastFill = null;
    runtime.set({ active: true, status: "playing", hidden: false, browsing: false });
    settings.set({ lastUrl: url, wasPlaying: true });
    applyLayout();
    setTimeout(() => applyMediaState(true), 4000);
  } catch (e: any) {
    await next.stop().catch(() => undefined);
    const message = e?.message || String(e);
    runtime.set({ active: false, status: "error", message, engine: null });
    toaster.toast({ title: "PiP Theater", body: message });
    backendLog("error", `start failed: ${message}`);
  }
}

async function stopEngine() {
  const e = engine;
  engine = null;
  overlay.set({ site: false });
  if (e) await e.stop().catch(console.error);
}

export async function stop() {
  await stopEngine();
  runtime.set({ active: false, status: "idle", engine: null, hidden: false, browsing: false, message: "" });
  settings.set({ wasPlaying: false });
}

export function command(cmd: MediaCommand) {
  engine?.run(mediaScript(cmd));
}

export function setHidden(hidden: boolean) {
  runtime.set({ hidden });
}

export function navigate(rawUrl: string) {
  const url = normalizeUrl(rawUrl);
  if (!url || !engine) return;
  engine.navigate(url);
  runtime.set({ url });
  settings.set({ lastUrl: url });
}

export function goBack() {
  engine?.back();
}

export function reload() {
  engine?.reload();
}

export async function refreshBrowsers() {
  try {
    runtime.set({ browsers: await listBrowsers() });
  } catch (e) {
    console.error(e);
  }
}

export async function initPlayer() {
  steamSupportsWidevine().then((ok) => runtime.set({ steamWidevine: ok }));
  refreshBrowsers();

  unsubscribers = [settings.subscribe(applyLayout), runtime.subscribe(applyLayout)];
  // Menus opening/closing and screen changes are polled: cheap and robust.
  timers = [setInterval(applyLayout, 250), setInterval(() => applyMediaState(false), 3000)];

  statusListener = addEventListener<[kind: string, message: string]>("pip_external_status", (kind, message) => {
    if (kind === "exited" && engine?.kind === "external") {
      engine = null;
      runtime.set({ active: false, status: "idle", engine: null, browsing: false });
    } else if (kind === "warning" || kind === "error") {
      toaster.toast({ title: "PiP Theater", body: message });
    }
  });

  const s = settings.get();
  if (s.resumeOnStartup && s.wasPlaying && s.lastUrl) {
    setTimeout(() => play(s.lastUrl), 3000);
  }
}

export async function disposePlayer() {
  timers.forEach(clearInterval);
  timers = [];
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  if (statusListener) removeEventListener("pip_external_status", statusListener);
  statusListener = null;
  await stopEngine();
}
