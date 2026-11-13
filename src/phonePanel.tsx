import { ButtonItem, DropdownItem, Field, PanelSection, PanelSectionRow, SliderField, TextField, ToggleField } from "@decky/ui";
import { useState } from "react";
import { FaMobileAlt } from "react-icons/fa";
import { compositionAvailable, compositionError } from "./composition";
import * as mirrorApi from "./mirror";
import { mirror, MirrorState } from "./mirror";
import { backendLog, runtime } from "./player";
import { MirrorSettings, setMirror, settings } from "./settings";
import { openMenu, uiScreen } from "./steam";
import { useStore } from "./store";
import { errText, Note } from "./ui";

const RECEIVER_TEXT: Record<string, string> = {
  off: "The AirPlay receiver is off, so phones can't see the Deck.",
  running: "Ready for your phone.",
  error: "The AirPlay receiver has a problem.",
};

const QUALITY: { data: MirrorSettings["quality"]; label: string }[] = [
  { data: "sharp", label: "Sharp (1080p)" },
  { data: "balanced", label: "Balanced (720p)" },
  { data: "saver", label: "Battery saver (540p)" },
];

const ACCESS: { data: MirrorSettings["access"]; label: string }[] = [
  { data: "anyone", label: "Anyone on this Wi-Fi" },
  { data: "pin", label: "Approved phones (PIN)" },
];

/** One-line status, e.g. "Mirroring Colby's iPhone, 1170x2532, 30 fps". */
export function mirrorStatus(st: MirrorState): string {
  const rc = st.receiver;
  if (rc.state !== "running") return RECEIVER_TEXT[rc.state] || rc.state;
  const who = st.client || "Phone";
  const rep = st.report;
  const live = rep.age !== null && rep.age < 5;
  if (st.session.mirroring) {
    let text = "Mirroring " + who;
    if (live && rep.w) text += ", " + rep.w + "x" + rep.h;
    if (!st.receiving) return text + " (still picture)";
    if (live && rep.fps) text += ", " + Math.round(rep.fps) + " fps";
    if (live && rep.delay) text += ", " + rep.delay + " ms on the Deck";
    return text;
  }
  return st.session.connected ? who + " connected (sound only)" : "Waiting for your phone";
}

export function PhoneTab() {
  const s = useStore(settings);
  const rt = useStore(mirror);
  const stream = useStore(runtime);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [forgetArmed, setForgetArmed] = useState(false);
  const [msg, setMsg] = useState("");

  const st = rt.state;
  if (!st) {
    return (
      <PanelSection title="Phone mirror">
        <Note tone={rt.error ? "fail" : undefined}>{rt.error || "Loading..."}</Note>
      </PanelSection>
    );
  }

  const m = s.mirror;
  const rc = st.receiver;
  const rep = st.report;
  const badDecode = rep.support === "no-webcodecs" || rep.support === "no-h264";

  return (
    <>
      <PanelSection title="Phone mirror">
        <PanelSectionRow>
          <Field
            label={mirrorStatus(st)}
            description={
              rc.state === "running"
                ? `On the phone (same Wi-Fi): Control Center > Screen Mirroring > ${m.name}.`
                : rc.message || "Turn the AirPlay receiver on below."
            }
            icon={<FaMobileAlt />}
          />
        </PanelSectionRow>
        {!st.ok && st.error ? <Note tone="fail">{st.error}</Note> : null}
        {rc.state === "error" ? (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => void mirrorApi.retryReceiver().then((r) => setMsg(r.ok ? "" : r.message)).catch((e) => setMsg(errText(e)))}
            >
              Try starting the receiver again
            </ButtonItem>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <ToggleField
            label="Show the phone window"
            description={stream.active ? "Turning this on stops the stream that is playing." : undefined}
            checked={rt.window}
            onChange={(v) => mirrorApi.setWindow(v)}
          />
        </PanelSectionRow>
        {rt.window && rt.viewError ? <Note tone="warn">{"Window problem: " + rt.viewError}</Note> : null}
        {rt.window && !compositionAvailable() ? <Note tone="warn">{compositionError}</Note> : null}
        {badDecode ? (
          <Note tone="warn">Steam's browser can't decode the phone's video on this system. See Help &gt; Check setup.</Note>
        ) : null}
        <PanelSectionRow>
          <SliderField
            label="Phone volume"
            description="Only the phone's sound. Game and system sound stay as they are."
            value={m.volume}
            min={0}
            max={100}
            step={5}
            showValue
            valueSuffix="%"
            onChange={(v) => setMirror({ volume: v })}
          />
        </PanelSectionRow>
        {msg ? <Note tone="warn">{msg}</Note> : null}
      </PanelSection>

      <PanelSection title="Mirroring options">
        <PanelSectionRow>
          <ToggleField
            label="AirPlay receiver"
            description="The Deck shows up under Screen Mirroring on phones, iPads and Macs."
            checked={m.receiverOn}
            disabled={rt.applying}
            onChange={(v) => setMirror({ receiverOn: v })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Open and close by itself"
            description="The window opens when the phone starts mirroring and closes a few seconds after it stops."
            checked={m.autoOpen}
            onChange={(v) => setMirror({ autoOpen: v })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Fill the window"
            description="Off: the window takes the phone's shape. On: the picture is cropped to the shape chosen under Window."
            checked={m.fill}
            onChange={(v) => setMirror({ fill: v })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem
            label="Picture quality"
            selectedOption={m.quality}
            rgOptions={QUALITY}
            disabled={rt.applying}
            onChange={(o) => setMirror({ quality: o.data })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="60 fps"
            description="Smoother motion, more battery."
            checked={m.fps60}
            disabled={rt.applying}
            onChange={(v) => setMirror({ fps60: v })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Low delay"
            description="Shows each frame as soon as it arrives; the sound may lag slightly behind the picture."
            checked={m.lowDelay}
            disabled={rt.applying}
            onChange={(v) => setMirror({ lowDelay: v })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <TextField label="Name phones see" value={nameDraft ?? m.name} onChange={(e) => setNameDraft(e.target.value)} />
        </PanelSectionRow>
        {nameDraft !== null && nameDraft.trim() !== m.name ? (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={rt.applying || !nameDraft.trim() || nameDraft.trim().length > 40}
              onClick={() => {
                setMirror({ name: nameDraft.trim() });
                setNameDraft(null);
              }}
            >
              Save name
            </ButtonItem>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <DropdownItem
            label="Who can mirror"
            selectedOption={m.access}
            rgOptions={ACCESS}
            disabled={rt.applying}
            onChange={(o) => setMirror({ access: o.data })}
          />
        </PanelSectionRow>
        {m.access === "pin" ? (
          <>
            <PanelSectionRow>
              <Field
                label={"PIN: " + (st.pin || "....")}
                description="A new phone types this once. After that it connects by itself."
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                disabled={rt.applying}
                onClick={() => {
                  if (!forgetArmed) {
                    setForgetArmed(true);
                    setTimeout(() => setForgetArmed(false), 4000);
                    return;
                  }
                  setForgetArmed(false);
                  void mirrorApi.forgetPhones().then((r) => setMsg(r.message)).catch((e) => setMsg(errText(e)));
                }}
              >
                {forgetArmed ? "Press again to forget them" : "Forget approved phones"}
              </ButtonItem>
            </PanelSectionRow>
          </>
        ) : null}
        <Note>
          Changing quality, 60 fps, low delay, the name or who can mirror restarts the receiver: a phone that is
          mirroring has to connect again.
        </Note>
      </PanelSection>

      <PanelSection title="Netflix and other protected apps">
        <Note>
          Netflix, Disney+, Prime Video and similar apps show a black picture when a phone mirrors them. The phone
          blocks it, on every AirPlay screen. Play them on the Deck itself instead, in this same window.
        </Note>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => settings.set({ tab: "watch" })}>
            Open Streaming
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

// --------------------------------------------------------------------------- //
// Help: check setup, problem report
// --------------------------------------------------------------------------- //

interface Line {
  ok: boolean | null;
  text: string;
}

async function collectDiagnostics(): Promise<Line[]> {
  const out: Line[] = [];
  const add = (ok: boolean | null, text: string) => out.push({ ok, text });

  let st: MirrorState | null = null;
  try {
    st = await mirrorApi.fetchState();
    add(st.ok, st.ok ? "Backend v" + st.version + " is answering" : "Backend: " + (st.error || "not ready"));
  } catch (e) {
    add(false, "Backend: " + errText(e));
  }
  try {
    const sys = await mirrorApi.systemCheck();
    add(null, sys.os || "System version unknown");
    add(!!sys.bundle, sys.bundle ? "AirPlay receiver included: " + sys.bundle.split("\n")[0] : "This build has no AirPlay receiver");
    if (sys.bundle_error) add(false, sys.bundle_error);
    add(sys.gstreamer, sys.gstreamer ? "GStreamer is installed" : "GStreamer is not installed");
    for (const [el, ok] of Object.entries(sys.elements)) add(ok, "  " + el + (ok ? " found" : " missing"));
    add(sys.ready, sys.ready ? "The AirPlay receiver has everything it needs" : "Something the AirPlay receiver needs is missing (see above)");
    for (const l of sys.recoveries) add(null, "Receiver restarted at " + l);
    for (const l of sys.receiver_output) add(null, "  receiver: " + l);
  } catch (e) {
    add(false, "System check: " + errText(e));
  }
  if (st) {
    const r = st.receiver;
    add(r.state === "running" ? true : r.state === "off" ? null : false, "AirPlay receiver: " + r.state + (r.message ? " (" + r.message + ")" : ""));
    add(!!st.rtp_port, st.rtp_port ? "Video input on port " + st.rtp_port : "No video input port");
    add(null, st.session.mirroring ? "A phone is mirroring" : st.session.connected ? "A phone is connected (sound only)" : "No phone connected");
    add(null, "Frames received " + st.frames + ", lost packets " + st.lost + (st.picture_lost ? ", key frame too far back" : ""));
    const p = st.report;
    const live = p.age !== null && p.age < 5;
    add(live ? true : null, live ? "The window's page is reporting" : "The window's page is not running (turn the window on)");
    if (p.support) add(p.support === "yes", "Steam's browser decodes H.264: " + p.support);
    if (p.w) add(null, `Picture ${p.w}x${p.h}, ${p.fps} fps, ${p.decoded} frames shown, codec ${p.codec}, ${p.restarts ?? 0} decoder restarts`);
    if (p.error) add(false, "Decoder: " + p.error);
    if (p.delay) add(null, "Delay on the Deck (receiver to screen): " + p.delay + " ms");
    add(null, "Phone volume " + st.options.volume + "%" + (st.volume_applied ? " (applied)" : ""));
  }
  const v = mirrorApi.phoneViewInfo();
  add(v.error ? false : v.exists ? true : null, v.error || (v.exists ? "Phone window created at " + v.rect : "Phone window not created (it is off)"));
  add(compositionAvailable(), compositionAvailable() ? "Steam composition hook found" : compositionError || "Composition hook missing");
  const sc = uiScreen();
  add(null, `Steam UI ${sc.w}x${sc.h}, open menu: ${openMenu()}`);
  const rt = runtime.get();
  add(null, "Steam's browser has Widevine DRM: " + (rt.steamWidevine === null ? "unknown" : rt.steamWidevine ? "yes" : "no"));
  add(rt.browsers.length > 0 ? true : null, rt.browsers.length ? "Browsers for DRM sites: " + rt.browsers.map((b) => b.name).join(", ") : "No browser for DRM sites installed (Chrome, Edge or Brave from Discover)");
  if (rt.status === "error") add(false, "Last streaming error: " + rt.message);
  return out;
}

const lineText = (l: Line) => (l.ok === null ? "INFO: " : l.ok ? "OK: " : "FAIL: ") + l.text;

export function HelpTab() {
  const rt = useStore(mirror);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const check = async () => {
    setBusy("Checking...");
    setMsg("");
    try {
      const out = await collectDiagnostics();
      setLines(out);
      void backendLog("info", out.map(lineText).join(" | "));
    } finally {
      setBusy("");
    }
  };

  const report = async () => {
    setBusy("Saving the report...");
    setMsg("");
    try {
      const out = await collectDiagnostics();
      setLines(out);
      const r = await mirrorApi.saveReport(out.map(lineText).join("\n"));
      setMsg(r.message + (r.ok ? ". Attach it to a GitHub issue." : ""));
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <PanelSection title="Help">
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!!busy} onClick={() => void check()}>
          Check setup
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={!!busy}
          description="Writes a text file to Downloads. It never contains your PIN."
          onClick={() => void report()}
        >
          Save problem report
        </ButtonItem>
      </PanelSectionRow>
      {busy ? <Note>{busy}</Note> : null}
      {msg ? <Note tone="warn">{msg}</Note> : null}
      {lines.length > 0 ? (
        <PanelSectionRow>
          <div style={{ fontSize: 11.5, lineHeight: 1.45, wordBreak: "break-word" }}>
            {lines.map((l, i) => (
              <div key={i} style={{ margin: "2px 0", opacity: l.ok === null ? 0.8 : 1, color: l.ok === null ? undefined : l.ok ? "#8fd1a5" : "#ff8a8a" }}>
                {lineText(l)}
              </div>
            ))}
          </div>
        </PanelSectionRow>
      ) : null}
      <Note>
        Phone mirroring needs the phone and the Deck on the same Wi-Fi; guest networks with "client isolation"
        block it. Expect about 0.1-0.3 s of delay: fine for watching, not for playing phone games.
      </Note>
      <Note>{"Version " + (rt.state?.version ?? "?") + ". Log: ~/homebrew/logs/PiP Theater/"}</Note>
    </PanelSection>
  );
}
