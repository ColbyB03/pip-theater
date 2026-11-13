# Installing, testing and publishing PiP Theater

This guide covers three stages:

1. Put the plugin on your own Deck and test it
2. Share it publicly through GitHub (anyone can install it)
3. The official Decky Plugin Store, and a policy you need to know about first

---

## ⚠️ Read first: the Decky store's AI policy

The Decky store's pull-request checklist requires you to tick:

> "Generative AI was NOT used to write a majority of the code I am submitting."

The store reviewers also say PRs can be denied "for suspected AI usage". **This plugin
was written by an AI (Claude)**, so as it stands you can't honestly tick that box.
Don't tick it anyway: it's a false statement, and the reviewers look for it.

Your realistic options:

- **Share it from GitHub (stage 2).** Many popular Decky plugins are distributed this
  way. Users install from a URL or ZIP in about 30 seconds.
- **Make it your own code first.** If you learn the codebase and rewrite or substantially
  author it yourself until AI-written code is no longer the majority, you can then submit
  it to the store (stage 3).

---

## Stage 1: install it on your Deck

### 1a. Build the ZIP (on your PC)

```bash
npm install
```

```bash
npm run package
```

This creates `out/pip-theater.zip`.

> On this Windows PC, if `npm run …` fails with `'"node"' is not recognized`, run the
> steps directly:
> `node node_modules/rollup/dist/bin/rollup -c` then `node scripts/package.mjs`

### 1b. Get the ZIP onto the Deck

Pick one:
- Copy it with a USB stick or SD card, **or**
- In Desktop Mode, download it from wherever you put it (Google Drive, GitHub, etc.), **or**
- Use [Warpinator](https://flathub.org/apps/org.x.Warpinator) / KDE Connect to send it from your PC.

Put it somewhere easy, like `~/Downloads/pip-theater.zip`.

### 1c. Turn on Decky developer mode (one time)

1. In Game Mode press **⋯** → Decky (plug icon) → ⚙️ **Settings**.
2. Turn on **Developer mode**.
3. A new **Developer** section appears in Decky's settings.

### 1d. Install

1. Decky Settings → **Developer** → **Install Plugin from ZIP File** → **Browse**.
2. Pick `pip-theater.zip` and confirm.
3. "PiP Theater" now shows in the Decky menu.

### 1e. Set up the DRM browser (for Netflix, Disney+, etc.)

1. Switch to **Desktop Mode** (Steam button → Power → Switch to Desktop).
2. Open **Discover**, search for **Google Chrome** (or Microsoft Edge / Brave) and install it.
3. Go back to Game Mode. You don't need to add Chrome to Steam.

### 1f. Test checklist

- [ ] YouTube plays in the PiP over a game (built-in engine)
- [ ] Netflix opens, **Browse & control** lets you log in and pick a show, and it plays
      in the PiP over a game (external engine)
- [ ] Size presets, the snap grid and the sliders move and resize the window live
- [ ] Opening the Quick Access menu moves the PiP out of the way
- [ ] Play/pause, ±10 s, volume and mute work
- [ ] Stop closes everything, including the background browser

### 1g. If something goes wrong: logs

- Plugin log: `~/homebrew/logs/PiP Theater/` (open it in Desktop Mode with Dolphin)
- Frontend console: in Decky Developer settings, enable **Allow Remote CEF Debugging**,
  then on your PC open Chrome → `chrome://inspect` → *Configure* → add `steamdeck:8081`
  (or your Deck's IP address) and inspect **SharedJSContext**.

You can send me (Claude) the log text and I'll help fix it.

---

## Stage 2: share it on GitHub

### 2a. One-time setup

1. Create a free account at <https://github.com>.
2. Edit these placeholders in the project:
   - `plugin.json` → `"author"` and the `image` URL
   - `LICENSE` → `YOUR_NAME_HERE`
   - `package.json` → add `"author": "Your Name"`
3. Optional: add a screenshot as `assets/preview.png`.

### 2b. Create the repository and push

On GitHub click **New repository**, name it `pip-theater`, keep it **Public**, and don't
add a README (you already have one). Then in this folder:

```bash
git init
```

```bash
git add .
```

```bash
git commit -m "Initial release of PiP Theater"
```

```bash
git branch -M main
```

```bash
git remote add origin https://github.com/YOUR_GITHUB_USER/pip-theater.git
```

```bash
git push -u origin main
```

(`.gitignore` already keeps `node_modules/`, `dist/` and `out/` out of the repo.)

### 2c. Publish a release

1. Bump `"version"` in `package.json` (for example `0.1.0`), rebuild with `npm run package`.
2. On GitHub: your repo → **Releases** → **Draft a new release**.
3. Tag: `v0.1.0`. Title: `PiP Theater 0.1.0`. Describe what's new.
4. Attach `out/pip-theater.zip`, then **Publish release**.

### 2d. Tell people how to install

Put this in your README or a Reddit post (r/SteamDeck, r/DeckyLoader):

> 1. Decky → Settings → enable **Developer mode**.
> 2. Developer → **Install Plugin from URL** and paste:
>    `https://github.com/YOUR_GITHUB_USER/pip-theater/releases/latest/download/pip-theater.zip`

For each update: bump the version, rebuild, create a new release with the new ZIP.

---

## Stage 3: the official Decky Plugin Store (only once the code is mostly your own)

The store is a GitHub repository,
[SteamDeckHomebrew/decky-plugin-database](https://github.com/SteamDeckHomebrew/decky-plugin-database).
You submit a pull request (PR) that adds your plugin's repo to it as a *git submodule*.
Their CI then builds the ZIP from your source, so you don't upload the ZIP yourself.

### 3a. Before you open the PR

- Test the plugin on both the **Stable** and **Beta** SteamOS update channels.
- **Test two other plugins' open PRs** in the database repo and leave a written testing
  report on each. This is required, and you link those comments from your PR.
- Explain how your plugin differs from the existing "Picture in Picture" plugin. Here:
  DRM support for Netflix/Disney+ via the external-browser engine.
- Read the review/testing page linked from the PR template:
  <https://wiki.deckbrew.xyz/plugin-dev/review-and-testing>

### 3b. Open the PR

1. **Fork** `decky-plugin-database` on GitHub (Fork button, top right).
2. Clone your fork and add your plugin:

```bash
git clone https://github.com/YOUR_GITHUB_USER/decky-plugin-database.git
```

```bash
cd decky-plugin-database
```

```bash
git checkout -b add/pip-theater
```

```bash
git submodule add https://github.com/YOUR_GITHUB_USER/pip-theater.git plugins/pip-theater
```

```bash
git commit -m "Add PiP Theater"
```

```bash
git push -u origin add/pip-theater
```

3. On GitHub, open a pull request from your branch to `SteamDeckHomebrew/decky-plugin-database`.
4. Choose the **Plugin addition** template and follow every instruction in it exactly.
   It says that not following the template can get the PR denied. Fill in the summary
   and the Yes/No backend questions. For this plugin: Python backend = yes; no custom
   binaries; it uses system `/usr/bin/python3`, `flatpak` and `libX11`, which ship with
   SteamOS. Tick only the boxes that are true.
5. Comment on the PR with links to your two testing reports.
6. Wait for a third-party tester and a reviewer. **Don't tick the "Tested by a third
   party" box yourself.** Track progress on the
   [SDH Tracker board](https://github.com/orgs/SteamDeckHomebrew/projects/9/views/11).

### 3c. Updating a store plugin later

Push your changes and bump the version in `package.json`, then in your database fork:

```bash
git checkout main
```

```bash
git pull upstream main
```

```bash
git checkout -b update/pip-theater
```

```bash
cd plugins/pip-theater && git pull origin main && cd ../..
```

```bash
git add plugins/pip-theater
```

```bash
git commit -m "Update PiP Theater to 0.2.0"
```

```bash
git push -u origin update/pip-theater
```

Then open a PR using the **Plugin update** template.
(Add the `upstream` remote once with
`git remote add upstream https://github.com/SteamDeckHomebrew/decky-plugin-database.git`.)
