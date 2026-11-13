import {
  ButtonItem,
  DialogButton,
  DropdownItem,
  Field,
  Navigation,
  PanelSection,
  PanelSectionRow,
  SliderField,
  TextField,
  ToggleField,
} from "@decky/ui";
import { useEffect, useState } from "react";
import {
  FaBackward,
  FaEye,
  FaEyeSlash,
  FaForward,
  FaGamepad,
  FaPlay,
  FaPause,
  FaStop,
  FaTrash,
  FaVolumeMute,
  FaVolumeUp,
} from "react-icons/fa";
import { mirror, setWindow } from "./mirror";
import { HelpTab, PhoneTab } from "./phonePanel";
import * as player from "./player";
import { runtime } from "./player";
import { Aspect, MenuBehavior, newId, settings, Tab } from "./settings";
import { EngineChoice, needsDrm, normalizeUrl, PRESET_SITES, resolveEngine, siteName } from "./sites";
import { useStore } from "./store";
import { ButtonRow, Note, selectedBtn, smallBtn } from "./ui";

export const BROWSE_ROUTE = "/pip-theater/browse";

const ENGINE_OPTIONS: { data: EngineChoice; label: string }[] = [
  { data: "auto", label: "Auto (recommended)" },
  { data: "builtin", label: "Steam built-in browser" },
  { data: "external", label: "External browser (DRM)" },
];

const SIZE_PRESETS: { label: string; size: number }[] = [
  { label: "S", size: 0.22 },
  { label: "M", size: 0.34 },
  { label: "L", size: 0.5 },
  { label: "XL", size: 0.7 },
];

const GRID: { label: string; x: number; y: number }[][] = [
  [
    { label: "↖", x: 0, y: 0 },
    { label: "↑", x: 0.5, y: 0 },
    { label: "↗", x: 1, y: 0 },
  ],
  [
    { label: "←", x: 0, y: 0.5 },
    { label: "•", x: 0.5, y: 0.5 },
    { label: "→", x: 1, y: 0.5 },
  ],
  [
    { label: "↙", x: 0, y: 1 },
    { label: "↓", x: 0.5, y: 1 },
    { label: "↘", x: 1, y: 1 },
  ],
];

function NowPlaying() {
  const rt = useStore(runtime);
  const s = useStore(settings);
  const [paused, setPaused] = useState(false);

  if (rt.status === "starting") {
    return (
      <PanelSection title="Now playing">
        <PanelSectionRow>
          <Field label="Starting…" description={siteName(rt.url)} />
        </PanelSectionRow>
        <ButtonItem layout="below" onClick={() => player.stop()}>
          Cancel
        </ButtonItem>
      </PanelSection>
    );
  }
  if (!rt.active) return null;

  return (
    <PanelSection title="Now playing">
      <PanelSectionRow>
        <Field
          label={siteName(rt.url)}
          description={rt.engine === "external" ? "External browser (DRM)" : "Steam built-in browser"}
        />
      </PanelSectionRow>
      <ButtonRow>
        <DialogButton style={smallBtn} onClick={() => player.command({ type: "seek", seconds: -10 })}>
          <FaBackward />
        </DialogButton>
        <DialogButton
          style={smallBtn}
          onClick={() => {
            player.command({ type: "toggle" });
            setPaused(!paused);
          }}
        >
          {paused ? <FaPlay /> : <FaPause />}
        </DialogButton>
        <DialogButton style={smallBtn} onClick={() => player.command({ type: "seek", seconds: 10 })}>
          <FaForward />
        </DialogButton>
      </ButtonRow>
      <ButtonRow>
        <DialogButton style={smallBtn} onClick={() => player.setHidden(!rt.hidden)}>
          {rt.hidden ? <FaEye /> : <FaEyeSlash />} {rt.hidden ? "Show" : "Hide"}
        </DialogButton>
        <DialogButton style={smallBtn} onClick={() => settings.set({ muted: !s.muted })}>
          {s.muted ? <FaVolumeMute /> : <FaVolumeUp />} {s.muted ? "Unmute" : "Mute"}
        </DialogButton>
      </ButtonRow>
      <PanelSectionRow>
        <SliderField
          label="Volume"
          value={s.volume}
          min={0}
          max={100}
          step={5}
          showValue
          valueSuffix="%"
          onChange={(v) => settings.set({ volume: v, muted: false })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Video fills window"
          description="Hide the website around the video"
          checked={s.fillVideo}
          onChange={(v) => settings.set({ fillVideo: v })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          description="Full screen: log in, pick a show, use the touchscreen"
          onClick={() => {
            Navigation.Navigate(BROWSE_ROUTE);
            Navigation.CloseSideMenus();
          }}
        >
          <FaGamepad style={{ marginRight: 8 }} /> Browse &amp; control
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => player.stop()}>
          <FaStop style={{ marginRight: 8 }} /> Stop
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

function Watch() {
  const s = useStore(settings);
  const rt = useStore(runtime);
  const [draft, setDraft] = useState(s.lastUrl);
  const [editBookmarks, setEditBookmarks] = useState(false);

  const target = normalizeUrl(draft);
  const engineFor = (url: string, choice: EngineChoice) =>
    resolveEngine(url, choice, rt.steamWidevine === true);

  const addBookmark = () => {
    if (!target) return;
    if (s.bookmarks.some((b) => b.url === target)) return;
    settings.set({
      bookmarks: [...s.bookmarks, { id: newId(), name: siteName(target), url: target, engine: s.engineChoice }],
    });
  };

  return (
    <PanelSection title="Watch">
      <PanelSectionRow>
        <TextField
          label="Website or search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          bShowClearAction
        />
      </PanelSectionRow>
      {target && (
        <PanelSectionRow>
          <Field
            description={
              engineFor(target, s.engineChoice) === "external"
                ? "Opens in the external browser (DRM site)"
                : "Opens in Steam's built-in browser"
            }
          />
        </PanelSectionRow>
      )}
      <ButtonRow>
        <DialogButton style={smallBtn} disabled={!target} onClick={() => player.play(draft)}>
          <FaPlay /> Watch
        </DialogButton>
        <DialogButton style={smallBtn} disabled={!target} onClick={addBookmark}>
          ★ Save
        </DialogButton>
      </ButtonRow>
      <PanelSectionRow>
        <DropdownItem
          label="Quick launch"
          strDefaultLabel="Pick a service…"
          selectedOption={null}
          rgOptions={PRESET_SITES.map((p) => ({
            data: p.url,
            label: needsDrm(p.url) ? `${p.name} (DRM)` : p.name,
          }))}
          onChange={(o) => {
            setDraft(o.data);
            player.play(o.data);
          }}
        />
      </PanelSectionRow>

      {s.bookmarks.length > 0 && (
        <>
          <PanelSectionRow>
            <Field label="Bookmarks" />
          </PanelSectionRow>
          {s.bookmarks.map((b) =>
            editBookmarks ? (
              <ButtonItem
                key={b.id}
                layout="below"
                onClick={() => settings.set({ bookmarks: s.bookmarks.filter((x) => x.id !== b.id) })}
              >
                <FaTrash style={{ marginRight: 8 }} /> {b.name}
              </ButtonItem>
            ) : (
              <ButtonItem
                key={b.id}
                layout="below"
                onClick={() => {
                  setDraft(b.url);
                  player.play(b.url, b.engine);
                }}
              >
                {b.name}
              </ButtonItem>
            ),
          )}
          <PanelSectionRow>
            <ToggleField label="Remove bookmarks" checked={editBookmarks} onChange={setEditBookmarks} />
          </PanelSectionRow>
        </>
      )}
    </PanelSection>
  );
}

function Layout() {
  const s = useStore(settings);
  const nudge = (dx: number, dy: number) =>
    settings.set({
      posX: Math.min(1, Math.max(0, s.posX + dx)),
      posY: Math.min(1, Math.max(0, s.posY + dy)),
    });

  return (
    <PanelSection title="Size & position">
      <ButtonRow>
        {SIZE_PRESETS.map((p) => (
          <DialogButton
            key={p.label}
            style={{ ...smallBtn, ...(Math.abs(s.size - p.size) < 0.01 ? selectedBtn : {}) }}
            onClick={() => settings.set({ size: p.size })}
          >
            {p.label}
          </DialogButton>
        ))}
      </ButtonRow>
      <PanelSectionRow>
        <SliderField
          label="Size"
          value={Math.round(s.size * 100)}
          min={15}
          max={95}
          step={1}
          showValue
          valueSuffix="% of width"
          onChange={(v) => settings.set({ size: v / 100 })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DropdownItem
          label="Shape"
          description="For streaming, and for the phone when Fill the window is on. Otherwise the phone window takes the phone's shape."
          selectedOption={s.aspect}
          rgOptions={(["16:9", "21:9", "4:3", "1:1"] as Aspect[]).map((a) => ({ data: a, label: a }))}
          onChange={(o) => settings.set({ aspect: o.data })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <Field label="Snap to" />
      </PanelSectionRow>
      {GRID.map((row, i) => (
        <ButtonRow key={i}>
          {row.map((cell) => (
            <DialogButton
              key={cell.label}
              style={{ ...smallBtn, ...(s.posX === cell.x && s.posY === cell.y ? selectedBtn : {}) }}
              onClick={() => settings.set({ posX: cell.x, posY: cell.y })}
            >
              {cell.label}
            </DialogButton>
          ))}
        </ButtonRow>
      ))}
      <PanelSectionRow>
        <SliderField
          label="Horizontal position"
          value={Math.round(s.posX * 100)}
          min={0}
          max={100}
          step={1}
          onChange={(v) => settings.set({ posX: v / 100 })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField
          label="Vertical position"
          value={Math.round(s.posY * 100)}
          min={0}
          max={100}
          step={1}
          onChange={(v) => settings.set({ posY: v / 100 })}
        />
      </PanelSectionRow>
      <ButtonRow>
        <DialogButton style={smallBtn} onClick={() => nudge(-0.02, 0)}>◀</DialogButton>
        <DialogButton style={smallBtn} onClick={() => nudge(0, -0.02)}>▲</DialogButton>
        <DialogButton style={smallBtn} onClick={() => nudge(0, 0.02)}>▼</DialogButton>
        <DialogButton style={smallBtn} onClick={() => nudge(0.02, 0)}>▶</DialogButton>
      </ButtonRow>
      <PanelSectionRow>
        <SliderField
          label="Edge margin"
          value={Math.round(s.margin * 1000) / 10}
          min={0}
          max={8}
          step={0.5}
          showValue
          valueSuffix="%"
          onChange={(v) => settings.set({ margin: v / 100 })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <DropdownItem
          label="When Steam menus open"
          selectedOption={s.menuBehavior}
          rgOptions={[
            { data: "dodge" as MenuBehavior, label: "Move out of the way" },
            { data: "hide" as MenuBehavior, label: "Hide the video" },
            { data: "stay" as MenuBehavior, label: "Do nothing" },
          ]}
          onChange={(o) => settings.set({ menuBehavior: o.data })}
        />
      </PanelSectionRow>
    </PanelSection>
  );
}

function Advanced() {
  const s = useStore(settings);
  const rt = useStore(runtime);

  useEffect(() => {
    player.refreshBrowsers();
  }, []);

  const browserOptions = rt.browsers.map((b) => ({ data: b.id, label: b.name }));
  const hasSelected = rt.browsers.some((b) => b.id === s.externalBrowser);

  return (
    <PanelSection title="Settings">
      <PanelSectionRow>
        <DropdownItem
          label="Playback engine"
          selectedOption={s.engineChoice}
          rgOptions={ENGINE_OPTIONS}
          onChange={(o) => settings.set({ engineChoice: o.data })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        {browserOptions.length > 0 ? (
          <DropdownItem
            label="Browser for DRM sites"
            selectedOption={hasSelected ? s.externalBrowser : null}
            strDefaultLabel="Choose…"
            rgOptions={browserOptions}
            onChange={(o) => settings.set({ externalBrowser: o.data })}
          />
        ) : (
          <Field
            label="Browser for DRM sites"
            description="None found. In Desktop Mode, install Google Chrome, Microsoft Edge or Brave from Discover."
          />
        )}
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Resume after restart"
          description="Re-open what you were watching when Steam starts"
          checked={s.resumeOnStartup}
          onChange={(v) => settings.set({ resumeOnStartup: v })}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <Field
          label="Steam browser DRM"
          description={
            rt.steamWidevine === null
              ? "Checking…"
              : rt.steamWidevine
                ? "Widevine available: DRM sites can use the built-in engine"
                : "No Widevine: Netflix, Disney+ and similar use the external browser"
          }
        />
      </PanelSectionRow>
      {rt.status === "error" && (
        <PanelSectionRow>
          <Field label="Last error" description={rt.message} />
        </PanelSectionRow>
      )}
    </PanelSection>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "phone", label: "Phone" },
  { id: "watch", label: "Streaming" },
  { id: "window", label: "Window" },
  { id: "help", label: "Help" },
];

/** Shown on the Window page when there is nothing on screen to see the changes on. */
function Preview() {
  const rt = useStore(runtime);
  const m = useStore(mirror);
  if (rt.active || m.window) return null;
  return (
    <PanelSection>
      <Note>Nothing is showing right now. Turn the phone window on to see your changes as you make them.</Note>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setWindow(true)}>
          Show the phone window
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

export function QuickAccessPanel() {
  const s = useStore(settings);
  const tab: Tab = TABS.some((t) => t.id === s.tab) ? s.tab : "phone";
  return (
    <>
      <PanelSection>
        <ButtonRow>
          {TABS.map((t) => (
            <DialogButton
              key={t.id}
              style={{ ...smallBtn, fontSize: 12, ...(t.id === tab ? selectedBtn : {}) }}
              onClick={() => settings.set({ tab: t.id })}
            >
              {t.label}
            </DialogButton>
          ))}
        </ButtonRow>
      </PanelSection>
      {tab === "phone" && <PhoneTab />}
      {tab === "watch" && (
        <>
          <NowPlaying />
          <Watch />
          <Advanced />
        </>
      )}
      {tab === "window" && (
        <>
          <Preview />
          <Layout />
        </>
      )}
      {tab === "help" && <HelpTab />}
    </>
  );
}
