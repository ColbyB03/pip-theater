import { addEventListener, callable, removeEventListener, toaster } from "@decky/api";
import { getGamepadNavigationTrees, Router } from "@decky/ui";
import { CdpClient, connectToPage } from "./cdp";
import { steamSupportsWidevine } from "./drm";
import { computeRect, hiddenByMenu, OpenMenu, Rect, Size } from "./geometry";
import { MediaCommand, mediaScript } from "./media";
import { settings } from "./settings";
import { Engine, EngineChoice, normalizeUrl, resolveEngine } from "./sites";
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
// Steam UI helpers
// --------------------------------------------------------------------------- //

function mainWindow(): any {
  return (Router as any)?.WindowStore?.GamepadUIMainWindowInstance;
}

export function uiScreen(): Size {
  const w: Window | undefined = mainWindow()?.BrowserWindow;
  return { w: w?.innerWidth || 1280, h: w?.innerHeight || 800 };
}

function quickAccessHiddenFallback(): boolean | null {
  try {
    const tree = getGamepadNavigationTrees().find((t: any) => t?.id === "QuickAccess-NA");
    const doc: Document | undefined = tree?.m_Root?.m_element?.ownerDocument;
    return doc ? doc.hidden : null;
  } catch {
    return null;
  }
}

export function openMenu(): OpenMenu {
  try {
    const store = mainWindow()?.MenuStore;
    const v = store?.GetOpenSideMenu?.() ?? store?.m_eOpenSideMenu;
    if (v === 1) return "main";
    if (v === 2) return "qam";
    if (v === 0) return "none";
  } catch {
    /* fall through */
  }
  const hidden = quickAccessHiddenFallback();
  return hidden === false ? "qam" : "none";
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
  private view: any = null;
  private lastLayout = "";

  async start(url: string) {
    const win = mainWindow();
    if (!win?.CreateBrowserView) throw new Error("Steam's browser view API is not available.");
    this.view = win.CreateBrowserView("pip-theater", {
      strInitialURL: url,
      bOnlyAllowTrustedPopups: true,
    });
    const browser = this.view.GetBrowser();
    try {
      browser.SetWindowStackingOrder?.(1); // keep above other Steam views
    } catch {
      /* optional */
    }
    browser.SetFocus?.(false);
    this.view.LoadURL(url);
  }

  navigate(url: string) {
    this.view?.LoadURL(url);
  }

  layout(rect: Rect, _screen: Size, visible: boolean, focus: boolean) {
    const browser = this.view?.GetBrowser();
    if (!browser) return;
    const key = JSON.stringify([rect, visible, focus]);
    if (key === this.lastLayout) return;
    this.lastLayout = key;
    browser.SetBounds(rect.x, rect.y, rect.width, rect.height);
    browser.SetVisible(visible);
    browser.SetFocus?.(focus);
  }

  run(script: string) {
    // A `javascript:` URL whose body evaluates to undefined runs in the current page
    // without navigating. Skip while a page is loading so we never cancel a navigation.
    if (!this.view || this.view.m_bLoading) return;
    this.view.GetBrowser().LoadURL("javascript:" + encodeURIComponent("void " + script.replace(/;\s*$/, "")));
  }

  back() {
    this.view?.GoBack?.();
  }

  reload() {
    this.view?.Reload?.();
  }

  async stop() {
    try {
      this.view?.Destroy();
    } catch (e) {
      console.error("[PiP Theater] destroy view failed", e);
    }
    this.view = null;
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
  if (!engine) return;
  const rt = runtime.get();
  const s = settings.get();
  const screen = uiScreen();

  if (rt.browsing) {
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
