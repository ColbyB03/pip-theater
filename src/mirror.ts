import { callable, toaster } from "@decky/api";
import { ASPECTS, computeRect, hiddenByMenu, PHONE_ASPECT } from "./geometry";
import * as player from "./player";
import { MirrorSettings, setMirror, settings } from "./settings";
import { openMenu, overlay, SteamView, uiScreen } from "./steam";
import { Store } from "./store";

// --------------------------------------------------------------------------- //
// Backend
// --------------------------------------------------------------------------- //

export interface MirrorReport {
  w?: number;
  h?: number;
  fps?: number;
  decoded?: number;
  dropped?: number;
  restarts?: number;
  codec?: string;
  error?: string;
  support?: string;
  delay?: number;
  age: number | null;
}

export interface MirrorState {
  ok: boolean;
  version: string;
  error: string | null;
  player_url: string | null;
  rtp_port: number | null;
  /** Video arrived in the last two seconds (a still phone screen sends none). */
  receiving: boolean;
  session: { connected: boolean; mirroring: boolean };
  client: string;
  options: Omit<MirrorSettings, "autoOpen">;
  /** Only set while a PIN is required. */
  pin: string;
  req_seq: number;
  receiver: { state: "off" | "running" | "error"; message: string; bundled: boolean };
  recoveries: string[];
  volume_applied: boolean;
  frames: number;
  lost: number;
  picture_lost: boolean;
  viewers: number;
  report: MirrorReport;
}

export interface SystemCheck {
  os: string;
  gstreamer: boolean;
  elements: Record<string, boolean>;
  bundle: string;
  bundle_error?: string;
  receiver_output: string[];
  recoveries: string[];
  ready: boolean;
}

export interface Result {
  ok: boolean;
  message: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("The plugin's background part isn't answering.")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const _state = callable<[], MirrorState>("mirror_state");
const _configure = callable<[options: Partial<MirrorSettings>], { ok: boolean; restarted: boolean }>("mirror_configure");
const _retry = callable<[], Result>("mirror_retry");
const _forget = callable<[], Result>("mirror_forget_phones");
const _check = callable<[], SystemCheck>("mirror_check");
const _report = callable<[extra: string], Result>("mirror_report");

export const fetchState = () => withTimeout(_state(), 3500);
export const retryReceiver = () => withTimeout(_retry(), 30000);
export const forgetPhones = () => withTimeout(_forget(), 30000);
export const systemCheck = () => withTimeout(_check(), 120000);
export const saveReport = (extra: string) => withTimeout(_report(extra), 150000);

// --------------------------------------------------------------------------- //
// Runtime state
// --------------------------------------------------------------------------- //

export interface MirrorRuntime {
  state: MirrorState | null;
  /** Why the backend could not be reached, if it could not. */
  error: string | null;
  /** The user (or auto-open) wants the phone window on screen. */
  window: boolean;
  /** The backend is applying new options (the receiver may be restarting). */
  applying: boolean;
  viewError: string | null;
}

export const mirror = new Store<MirrorRuntime>({
  state: null,
  error: null,
  window: false,
  applying: false,
  viewError: null,
});

const AUTO_CLOSE_MS = 4000;
const view = new SteamView("pip-theater-mirror");

let timers: ReturnType<typeof setInterval>[] = [];
let unsubscribers: (() => void)[] = [];
let busy = false;
let wasMirroring = false;
let stoppedAt = 0; // when the phone stopped mirroring (0 = not waiting to close the window)
let lastReq: number | null = null;
let pushed = ""; // the options the backend was last given
let pushTimer: ReturnType<typeof setTimeout> | undefined;

function toast(body: string) {
  try {
    toaster.toast({ title: "PiP Theater", body });
  } catch {
    /* toasts are a nicety */
  }
}

/** Show or hide the phone window. Showing it stops a stream: there is one PiP window. */
export function setWindow(on: boolean) {
  if (on && (player.runtime.get().active || player.runtime.get().status === "starting")) void player.stop();
  stoppedAt = 0;
  mirror.set({ window: on });
}

// ---- backend poll: status, auto open / close, PIN notification ------------- //

export async function refresh(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const st = await fetchState();
    mirror.set({ state: st, error: null });
    const auto = settings.get().mirror.autoOpen;
    const mirroring = st.session.mirroring;
    const streaming = player.runtime.get().active;

    if (mirroring && !wasMirroring && auto && !mirror.get().window) {
      if (streaming) toast((st.client || "A phone") + " is mirroring. Open PiP Theater > Phone to show it.");
      else mirror.set({ window: true });
    }
    if (!mirroring && wasMirroring) stoppedAt = Date.now();
    if (mirroring) stoppedAt = 0;
    if (stoppedAt && Date.now() - stoppedAt >= AUTO_CLOSE_MS) {
      stoppedAt = 0;
      if (auto && mirror.get().window) mirror.set({ window: false });
    }
    wasMirroring = mirroring;

    // A phone asks to connect while a PIN is required: show the PIN wherever you are on the Deck.
    if (lastReq !== null && st.req_seq > lastReq && st.pin) {
      toast((st.client || "A phone") + " wants to mirror. PIN: " + st.pin);
    }
    lastReq = st.req_seq;
  } catch (e) {
    mirror.set({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    busy = false;
  }
}

// ---- settings -> backend ---------------------------------------------------- //

function backendOptions(): Omit<MirrorSettings, "autoOpen"> {
  const { autoOpen: _autoOpen, ...rest } = settings.get().mirror;
  return rest;
}

async function pushOptions() {
  const opts = backendOptions();
  const key = JSON.stringify(opts);
  if (key === pushed) return;
  pushed = key;
  mirror.set({ applying: true });
  try {
    await withTimeout(_configure(opts), 30000);
  } catch (e) {
    pushed = ""; // try again on the next change
    toast("Could not apply the mirror settings: " + (e instanceof Error ? e.message : String(e)));
  } finally {
    mirror.set({ applying: false });
    void refresh();
  }
}

function schedulePush() {
  if (JSON.stringify(backendOptions()) === pushed) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void pushOptions(), 350);
}

// ---- the phone window -------------------------------------------------------- //

/** The shape of the phone window: the phone's own shape, or the chosen window shape when filling. */
export function phoneAspect(): number {
  const s = settings.get();
  if (s.mirror.fill) return ASPECTS[s.aspect] ?? 16 / 9;
  const rep = mirror.get().state?.report;
  return rep?.w && rep?.h ? Math.round((rep.w / rep.h) * 100) / 100 : PHONE_ASPECT;
}

/**
 * Keeps the Steam view that shows the mirror page in step with what is wanted. The view exists
 * whenever the window is on *or* a phone is mirroring: a phone sends a full picture only when
 * mirroring starts, so the page has to keep decoding even while the window is hidden, or showing
 * it later would have nothing to build the picture from.
 */
export function layoutPhone() {
  const rt = mirror.get();
  const st = rt.state;
  const stream = player.runtime.get();
  const streaming = stream.active || stream.status === "starting";
  const wanted = !!st?.player_url && !streaming && (rt.window || !!st?.session.mirroring);

  if (!wanted) {
    view.destroy();
    overlay.set({ phone: false });
    return;
  }
  if (!view.create()) {
    overlay.set({ phone: false });
    mirror.set({ viewError: view.error });
    return;
  }
  view.load(st!.player_url!);
  const s = settings.get();
  const menu = openMenu();
  const rect = computeRect(s, uiScreen(), menu, { aspect: phoneAspect(), equalArea: !s.mirror.fill });
  const visible = rt.window && !hiddenByMenu(s.menuBehavior, menu);
  view.layout(rect, visible, false);
  overlay.set({ phone: visible });
  mirror.set({ viewError: view.error });
}

export function phoneViewInfo(): { exists: boolean; error: string | null; rect: string } {
  const r = view.lastRect;
  return { exists: view.exists, error: view.error, rect: r ? `${r.x},${r.y} ${r.width}x${r.height}` : "" };
}

// ---- lifecycle ---------------------------------------------------------------- //

export function initMirror() {
  pushed = "";
  void pushOptions(); // make sure the backend runs with what the panel shows
  void refresh();
  timers = [setInterval(() => void refresh(), 1000), setInterval(layoutPhone, 250)];
  unsubscribers = [
    settings.subscribe(() => {
      schedulePush();
      layoutPhone();
    }),
    mirror.subscribe(layoutPhone),
    // Starting a stream takes over the PiP window.
    player.runtime.subscribe(() => {
      const p = player.runtime.get();
      if ((p.active || p.status === "starting") && mirror.get().window) mirror.set({ window: false });
      layoutPhone();
    }),
  ];
}

export function disposeMirror() {
  timers.forEach(clearInterval);
  timers = [];
  clearTimeout(pushTimer);
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  view.destroy();
  overlay.set({ phone: false });
}

export { setMirror };
