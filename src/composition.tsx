import { findModuleChild } from "@decky/ui";
import { overlay } from "./steam";
import { useStore } from "./store";

// Steam keeps its UI layer under the running game unless a component asks for a "minimum
// composition state". Level 1 (Notification) draws the UI layer over the game without taking
// input, which is what makes a Steam browser view visible in game.
// Approach from decky-pip and decky-screen-mirror (both BSD-3-Clause).
enum UIComposition {
  Hidden = 0,
  Notification = 1,
  Overlay = 2,
  Opaque = 3,
  OverlayKeyboard = 4,
}

type UseUIComposition = (composition: UIComposition) => { releaseComposition: () => void };

let hook: UseUIComposition | null = null;
export let compositionError: string | null = null;

try {
  const found = findModuleChild((m: any) => {
    if (typeof m !== "object") return undefined;
    for (const prop in m) {
      if (typeof m[prop] !== "function") continue;
      const src = m[prop].toString();
      if (
        src.includes("AddMinimumCompositionStateRequest") &&
        src.includes("ChangeMinimumCompositionStateRequest") &&
        src.includes("RemoveMinimumCompositionStateRequest") &&
        !src.includes("m_mapCompositionStateRequests")
      ) {
        return m[prop];
      }
    }
    return undefined;
  });
  hook = (found as UseUIComposition) ?? null;
  if (!hook) compositionError = "Steam's composition hook was not found (a Steam update may have moved it).";
} catch (e) {
  compositionError = "Searching for the composition hook failed: " + (e instanceof Error ? e.message : String(e));
}

export const compositionAvailable = (): boolean => hook !== null;

/** Mounted only while a view is showing; the request is released when it unmounts. */
const Composition = () => {
  if (hook) hook(UIComposition.Notification);
  return null;
};

/** Global component: holds Steam's UI layer above the game exactly while one of our views is on screen. */
export const PipHost = () => {
  const o = useStore(overlay);
  return o.site || o.phone ? <Composition /> : null;
};
