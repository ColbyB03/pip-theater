import { callable } from "@decky/api";
import { Store } from "./store";
import { EngineChoice } from "./sites";

export type Aspect = "16:9" | "4:3" | "21:9" | "1:1";
export type MenuBehavior = "dodge" | "hide" | "stay";

export interface Bookmark {
  id: string;
  name: string;
  url: string;
  engine: EngineChoice;
}

export interface Settings {
  version: 1;
  /** PiP width as a fraction of the screen width. */
  size: number;
  aspect: Aspect;
  /** 0 = left/top edge, 1 = right/bottom edge (within the margins). */
  posX: number;
  posY: number;
  /** Gap to the screen edge, as a fraction of the screen height. */
  margin: number;
  volume: number; // 0-100
  muted: boolean;
  /** What to do when the Steam / Quick Access menus open. */
  menuBehavior: MenuBehavior;
  /** Make the video element fill the whole PiP window (hides site chrome). */
  fillVideo: boolean;
  engineChoice: EngineChoice;
  externalBrowser: string;
  bookmarks: Bookmark[];
  lastUrl: string;
  /** Re-open the last stream automatically after Steam restarts. */
  resumeOnStartup: boolean;
  wasPlaying: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  size: 0.34,
  aspect: "16:9",
  posX: 1,
  posY: 0,
  margin: 0.025,
  volume: 80,
  muted: false,
  menuBehavior: "dodge",
  fillVideo: false,
  engineChoice: "auto",
  externalBrowser: "com.google.Chrome",
  bookmarks: [],
  lastUrl: "",
  resumeOnStartup: false,
  wasPlaying: false,
};

export const settings = new Store<Settings>(DEFAULT_SETTINGS);

const loadSettings = callable<[], Partial<Settings> | null>("get_settings");
const saveSettings = callable<[s: Settings], boolean>("save_settings");

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let loaded = false;

export async function initSettings() {
  try {
    const stored = await loadSettings();
    if (stored) settings.set({ ...DEFAULT_SETTINGS, ...stored, version: 1 });
  } catch (e) {
    console.error("[PiP Theater] failed to load settings", e);
  }
  loaded = true;
  settings.subscribe(() => {
    if (!loaded) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSettings(settings.get()).catch(console.error), 600);
  });
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
