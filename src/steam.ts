import { getGamepadNavigationTrees, Router } from "@decky/ui";
import type { OpenMenu, Rect, Size } from "./geometry";
import { Store } from "./store";

/**
 * Everything that touches undocumented Steam internals lives here, wrapped so that a
 * Steam update which changes them gives a readable error instead of breaking the plugin.
 */

export function mainWindow(): any {
  try {
    return (Router as any)?.WindowStore?.GamepadUIMainWindowInstance ?? null;
  } catch {
    return null;
  }
}

const saneSize = (w: unknown, h: unknown): boolean =>
  typeof w === "number" && typeof h === "number" && w >= 320 && w <= 8000 && h >= 200 && h <= 5000;

/**
 * Size of Steam's UI in the units SetBounds uses. Steam scales its UI, so on a Steam Deck this
 * is 854x534 rather than the panel's 1280x800; that is also the fallback.
 */
export function uiScreen(): Size {
  const w: Window | undefined = mainWindow()?.BrowserWindow;
  if (w && saneSize(w.innerWidth, w.innerHeight)) return { w: w.innerWidth, h: w.innerHeight };
  return { w: 854, h: 534 };
}

function quickAccessShowing(): boolean | null {
  try {
    const tree = getGamepadNavigationTrees().find((t: any) => t?.id === "QuickAccess-NA");
    const win: any = tree?.m_Root?.m_element?.ownerDocument?.defaultView;
    const main = mainWindow()?.BrowserWindow;
    // A menu living in the main window says nothing: the main window is always "showing".
    if (!win || win === main) return null;
    return !win.document.hidden;
  } catch {
    return null;
  }
}

/** Which Steam side menu is open right now. Cheap enough to poll. */
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
  return quickAccessShowing() === true ? "qam" : "none";
}

/** Which of our views is on screen right now: decides whether Steam's UI layer must be drawn over the game. */
export const overlay = new Store<{ site: boolean; phone: boolean }>({ site: false, phone: false });

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One Steam browser view (the same thing Steam uses for its own web pages), drawn above the game.
 * Every call is de-duplicated and guarded; a view left over from a previous load of the plugin
 * is destroyed first.
 */
export class SteamView {
  private view: any = null;
  private browser: any = null;
  private url = "";
  private layoutKey = "";
  error: string | null = null;
  lastRect: Rect | null = null;

  constructor(private readonly name: string) {}

  get exists(): boolean {
    return this.view !== null;
  }

  create(): boolean {
    if (this.view) return true;
    try {
      const w = window as any;
      const leftovers: Record<string, any> = (w.__pipTheaterViews ??= {});
      if (leftovers[this.name]) {
        try {
          leftovers[this.name].Destroy();
        } catch {
          /* already gone */
        }
        delete leftovers[this.name];
      }
      const win = mainWindow();
      if (!win || typeof win.CreateBrowserView !== "function") {
        this.error = "Steam's browser view is not available (a Steam update may have changed it).";
        return false;
      }
      const view = win.CreateBrowserView(this.name);
      const browser = view?.GetBrowser?.();
      if (!view || !browser) {
        this.error = "Steam did not create a usable browser view.";
        return false;
      }
      this.view = view;
      this.browser = browser;
      this.url = "";
      this.layoutKey = "";
      this.error = null;
      leftovers[this.name] = view;
      this.guard("SetVisible", () => browser.SetVisible(false));
      return true;
    } catch (e) {
      this.error = "Could not create the video view: " + errText(e);
      this.view = this.browser = null;
      return false;
    }
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.error = what + " failed: " + errText(e);
    }
  }

  /** Loads `url` unless it is what the view was last told to load. */
  load(url: string): void {
    if (!this.view || url === this.url) return;
    this.url = url;
    this.guard("LoadURL", () => this.view.LoadURL(url));
  }

  navigate(url: string): void {
    this.url = "";
    this.load(url);
  }

  layout(rect: Rect, visible: boolean, focus: boolean): void {
    if (!this.browser) return;
    this.lastRect = rect;
    const key = JSON.stringify([rect, visible, focus]);
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.guard("SetBounds", () => this.browser.SetBounds(rect.x, rect.y, rect.width, rect.height));
    this.guard("SetVisible", () => this.browser.SetVisible(visible));
    this.guard("SetFocus", () => this.browser.SetFocus?.(focus));
  }

  /** Runs a statement in the page. Skipped while a page is loading so it never cancels a navigation. */
  run(script: string): void {
    if (!this.view || this.view.m_bLoading) return;
    try {
      this.browser.LoadURL("javascript:" + encodeURIComponent("void " + script.replace(/;\s*$/, "")));
    } catch {
      /* the page is gone or busy; the next tick tries again */
    }
  }

  back(): void {
    this.guard("GoBack", () => this.view?.GoBack?.());
  }

  reload(): void {
    this.guard("Reload", () => this.view?.Reload?.());
  }

  destroy(): void {
    if (!this.view) return;
    const v = this.view;
    this.view = this.browser = null;
    this.url = "";
    this.layoutKey = "";
    try {
      v.Destroy();
    } catch {
      /* ignore */
    }
    const leftovers = (window as any).__pipTheaterViews;
    if (leftovers && leftovers[this.name] === v) delete leftovers[this.name];
  }
}
