/**
 * JavaScript that runs *inside* the streaming page to control playback.
 * Shared by both engines. Every script is a self-contained statement.
 */

export type MediaCommand =
  | { type: "toggle" }
  | { type: "seek"; seconds: number }
  | { type: "volume"; volume: number; muted: boolean }
  | { type: "rate"; rate: number }
  | { type: "fill"; enabled: boolean };

const HELPERS = `
  function pipFindMedia() {
    var found = [];
    function walk(root) {
      try {
        root.querySelectorAll('video,audio').forEach(function (m) { found.push(m); });
        root.querySelectorAll('*').forEach(function (el) { if (el.shadowRoot) walk(el.shadowRoot); });
        root.querySelectorAll('iframe').forEach(function (f) {
          try { if (f.contentDocument) walk(f.contentDocument); } catch (e) {}
        });
      } catch (e) {}
    }
    walk(document);
    if (!found.length) return null;
    var playing = found.filter(function (m) { return !m.paused && !m.ended; });
    var pool = playing.length ? playing : found;
    pool.sort(function (a, b) {
      return (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight);
    });
    return pool[0];
  }
  function pipNetflixPlayer() {
    try {
      var vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      var ids = vp.getAllPlayerSessionIds();
      return ids.length ? vp.getVideoPlayerBySessionId(ids[ids.length - 1]) : null;
    } catch (e) { return null; }
  }
`;

const FILL_CSS = `
  .pip-theater-fill { position: fixed !important; inset: 0 !important; width: 100vw !important;
    height: 100vh !important; max-width: none !important; max-height: none !important;
    z-index: 2147483646 !important; object-fit: contain !important; background: #000 !important;
    transform: none !important; }
  html.pip-theater-filled, html.pip-theater-filled body { overflow: hidden !important; }
`;

function body(cmd: MediaCommand): string {
  switch (cmd.type) {
    case "toggle":
      return `
        var nf = pipNetflixPlayer();
        if (nf) { nf.isPaused() ? nf.play() : nf.pause(); return; }
        var m = pipFindMedia(); if (!m) return;
        if (m.paused) { m.play(); } else { m.pause(); }`;
    case "seek":
      // Netflix's player errors out (M7375) if currentTime is changed directly.
      return `
        var nf = pipNetflixPlayer();
        if (nf) { nf.seek(Math.max(0, nf.getCurrentTime() + ${cmd.seconds * 1000})); return; }
        var m = pipFindMedia(); if (!m) return;
        m.currentTime = Math.max(0, m.currentTime + ${cmd.seconds});`;
    case "volume": {
      const v = Math.max(0, Math.min(1, cmd.volume));
      return `
        var m = pipFindMedia(); if (!m) return;
        if (Math.abs(m.volume - ${v}) > 0.01) m.volume = ${v};
        if (m.muted !== ${cmd.muted}) m.muted = ${cmd.muted};`;
    }
    case "rate":
      return `var m = pipFindMedia(); if (m) m.playbackRate = ${cmd.rate};`;
    case "fill":
      return `
        var style = document.getElementById('pip-theater-fill-style');
        if (!style) {
          style = document.createElement('style'); style.id = 'pip-theater-fill-style';
          style.textContent = ${JSON.stringify(FILL_CSS)};
          (document.head || document.documentElement).appendChild(style);
        }
        document.querySelectorAll('.pip-theater-fill').forEach(function (el) { el.classList.remove('pip-theater-fill'); });
        document.documentElement.classList.toggle('pip-theater-filled', ${cmd.enabled});
        if (${cmd.enabled}) { var m = pipFindMedia(); if (m && m.tagName === 'VIDEO') m.classList.add('pip-theater-fill'); }`;
  }
}

/** A statement (no result value) that applies `cmd` in the page. */
export function mediaScript(cmd: MediaCommand): string {
  return `(function () { try { ${HELPERS} ${body(cmd)} } catch (e) {} })();`;
}
