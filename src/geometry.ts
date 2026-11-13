import { Aspect, MenuBehavior, Settings } from "./settings";

export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ASPECTS: Record<Aspect, number> = {
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "21:9": 21 / 9,
  "1:1": 1,
};

/** Approximate share of the screen covered by the Quick Access Menu (right side). */
const QAM_FRACTION = 0.36;
/** Approximate share covered by the Steam main menu (left side). */
const MAIN_MENU_FRACTION = 0.28;

export type OpenMenu = "none" | "main" | "qam";

/** A portrait phone, until the real picture says otherwise. */
export const PHONE_ASPECT = 9 / 19.5;

export interface Shape {
  /** width / height */
  aspect: number;
  /**
   * Give the window the same area as a 16:9 window of the chosen size, whatever its shape.
   * Used for the phone: a tall portrait window and a wide landscape one then look "the same size",
   * instead of the portrait one being a sliver.
   */
  equalArea?: boolean;
}

export function computeRect(s: Settings, screen: Size, menu: OpenMenu, shape?: Shape): Rect {
  const wanted = shape?.aspect ?? ASPECTS[s.aspect] ?? 16 / 9;
  const ar = wanted > 0.2 && wanted < 5 ? wanted : 16 / 9;
  const m = Math.round(s.margin * screen.h);

  let width = s.size * screen.w;
  let height = width / ar;
  if (shape?.equalArea) {
    const area = (s.size * screen.w * (s.size * screen.w)) / (16 / 9);
    width = Math.sqrt(area * ar);
    height = Math.sqrt(area / ar);
  }
  const maxH = screen.h - 2 * m;
  const maxW = screen.w - 2 * m;
  if (height > maxH) {
    height = maxH;
    width = height * ar;
  }
  if (width > maxW) {
    width = maxW;
    height = width / ar;
  }

  let x = m + s.posX * (screen.w - width - 2 * m);
  const y = m + s.posY * (screen.h - height - 2 * m);

  if (menu !== "none" && s.menuBehavior === "dodge") {
    const gap = 8;
    if (menu === "qam") {
      const limit = screen.w * (1 - QAM_FRACTION) - gap;
      if (width > limit - m) {
        width = limit - m;
        height = width / ar;
      }
      if (x + width > limit) x = Math.max(m, limit - width);
    } else {
      const start = screen.w * MAIN_MENU_FRACTION + gap;
      if (width > screen.w - m - start) {
        width = screen.w - m - start;
        height = width / ar;
      }
      if (x < start) x = start;
    }
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

export function hiddenByMenu(behavior: MenuBehavior, menu: OpenMenu): boolean {
  return behavior === "hide" && menu !== "none";
}
