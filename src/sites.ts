export type EngineChoice = "auto" | "builtin" | "external";
export type Engine = "builtin" | "external";

export interface Site {
  name: string;
  url: string;
}

export const PRESET_SITES: Site[] = [
  { name: "Netflix", url: "https://www.netflix.com/browse" },
  { name: "Disney+", url: "https://www.disneyplus.com/" },
  { name: "Max", url: "https://play.max.com/" },
  { name: "Prime Video", url: "https://www.primevideo.com/" },
  { name: "Hulu", url: "https://www.hulu.com/" },
  { name: "Paramount+", url: "https://www.paramountplus.com/" },
  { name: "Peacock", url: "https://www.peacocktv.com/" },
  { name: "Apple TV+", url: "https://tv.apple.com/" },
  { name: "Crunchyroll", url: "https://www.crunchyroll.com/" },
  { name: "YouTube", url: "https://www.youtube.com/" },
  { name: "Twitch", url: "https://www.twitch.tv/" },
  { name: "Kick", url: "https://kick.com/" },
  { name: "Plex", url: "https://app.plex.tv/" },
  { name: "Spotify", url: "https://open.spotify.com/" },
];

/** Hosts whose video needs Widevine DRM, which Steam's built-in browser lacks. */
const DRM_HOSTS = [
  "netflix.com",
  "disneyplus.com",
  "max.com",
  "hbomax.com",
  "primevideo.com",
  "amazon.com",
  "hulu.com",
  "paramountplus.com",
  "peacocktv.com",
  "tv.apple.com",
  "crunchyroll.com",
  "spotify.com",
  "sling.com",
  "fubo.tv",
  "starz.com",
  "showtime.com",
  "discoveryplus.com",
];

export function normalizeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^[^\s]+\.[^\s]{2,}$/.test(t)) return "https://" + t;
  return "https://www.google.com/search?q=" + encodeURIComponent(t);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function needsDrm(url: string): boolean {
  const h = hostOf(url);
  return DRM_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

export function resolveEngine(url: string, choice: EngineChoice, steamHasWidevine: boolean): Engine {
  if (choice !== "auto") return choice;
  return needsDrm(url) && !steamHasWidevine ? "external" : "builtin";
}

export function siteName(url: string): string {
  const preset = PRESET_SITES.find((s) => hostOf(s.url) === hostOf(url));
  if (preset) return preset.name;
  return hostOf(url).replace(/^www\./, "") || url;
}
