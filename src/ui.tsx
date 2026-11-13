import { Focusable, PanelSectionRow } from "@decky/ui";
import { CSSProperties, ReactNode } from "react";

export const smallBtn: CSSProperties = {
  minWidth: 0,
  flex: 1,
  padding: "8px 4px",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  gap: 6,
};

/** Highlight for the selected button in a row of choices. */
export const selectedBtn: CSSProperties = {
  background: "#1a9fff",
  color: "#fff",
  fontWeight: 700,
};

export function ButtonRow({ children }: { children: ReactNode }) {
  return (
    <PanelSectionRow>
      <Focusable style={{ display: "flex", gap: 6, padding: "4px 0" }} flow-children="horizontal">
        {children}
      </Focusable>
    </PanelSectionRow>
  );
}

/** A block of small text inside a panel section. */
export function Note({ children, tone }: { children: ReactNode; tone?: "warn" | "ok" | "fail" }) {
  const color = tone === "warn" ? "#ffb86b" : tone === "ok" ? "#8fd1a5" : tone === "fail" ? "#ff8a8a" : undefined;
  return (
    <PanelSectionRow>
      <div style={{ fontSize: 12, lineHeight: 1.4, opacity: tone ? 1 : 0.8, color, padding: "4px 0", wordBreak: "break-word" }}>
        {children}
      </div>
    </PanelSectionRow>
  );
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
