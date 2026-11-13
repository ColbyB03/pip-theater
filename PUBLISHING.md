# Installing, testing and publishing PiP Theater

This guide covers three stages:

1. Publish it on GitHub (GitHub builds the installable ZIP for you)
2. Install it on your Deck and test it
3. The official Decky Plugin Store, and a policy you need to know about first

---

## ⚠️ Read first: the Decky store's AI policy

The Decky store's pull-request checklist requires you to tick:

> "Generative AI was NOT used to write a majority of the code I am submitting."

The store reviewers also say PRs can be denied "for suspected AI usage". **This plugin
was written by an AI (Claude)**, so as it stands you can't honestly tick that box.
Don't tick it anyway: it's a false statement, and the reviewers look for it.

Your realistic options:

- **Share it from GitHub (stages 1 and 2).** Many popular Decky plugins are distributed this
  way. Users install from a URL or ZIP in about 30 seconds.
- **Make it your own code first.** If you learn the codebase and rewrite or substantially
  author it yourself until AI-written code is no longer the majority, you can then submit
  it to the store (stage 3).

---

## Stage 1: publish it on GitHub

The repository has a release workflow (`.github/workflows/release.yml`). GitHub builds the
AirPlay receiver from source, builds the plugin, runs the tests, and attaches
`pip-theater.zip` to a release. You don't build anything on your PC.

### 1a. Create the repository and push (one time)

On GitHub click **New repository**, name it `pip-theater`, keep it **Public**, and don't add
a README, license or .gitignore (the project has them). Then in this folder:

```bash
git remote add origin https://github.com/ColbyB03/pip-theater.git
```

```bash
git push -u origin main
```

If your GitHub user name is not `ColbyB03`, change it in that command, in `README.md` (the
install URL), in `plugin.json` (`author`) and in `LICENSE`.

### 1b. Publish a release

1. Set `"version"` in `package.json` (for example `0.2.0`) and commit.
2. Tag it and push the tag:

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

3. On GitHub, open the **Actions** tab and watch the **Release** run (about 5 minutes).
   When it is green, the release with `pip-theater.zip` is on the **Releases** page.

If the run fails, open it, copy the red step's log, and send it to me (Claude).

To try a build without making a release: **Actions** > **Release** > **Run workflow**. The
ZIP is then attached to that run as an artifact.

### 1c. Updates

Change the code, bump the version, commit, tag (`v0.2.1`...), push the tag. People who
installed from the URL below get the new version by installing from the same URL again.

---

## Stage 2: install it on your Deck

### 2a. Turn on Decky developer mode (one time)

1. In Game Mode press **...** > Decky (plug icon) > gear icon.
2. Turn on **Developer mode**. A **Developer** section appears in Decky's settings.

### 2b. Install

**Developer** > **Install Plugin from URL**, and enter:

```
https://github.com/ColbyB03/pip-theater/releases/latest/download/pip-theater.zip
```

"PiP Theater" now shows in the Decky menu.

Without GitHub (to test a ZIP built on this PC): copy `out/pip-theater.zip` to the Deck
(USB stick, SD card, KDE Connect...) and use **Developer** > **Install Plugin from ZIP File**.
A ZIP built on this PC only has the AirPlay receiver if `bin/uxplay-steamos/` exists here;
`node scripts/package.mjs` warns when it doesn't.

### 2c. Set up the DRM browser (for Netflix, Disney+, etc.)

1. Switch to **Desktop Mode** (Steam button > Power > Switch to Desktop).
2. Open **Discover**, search for **Google Chrome** (or Microsoft Edge / Brave) and install it.
3. Go back to Game Mode. You don't need to add Chrome to Steam.

### 2d. Test checklist

Phone mirror:
- [ ] The Deck shows up under Screen Mirroring on the phone
- [ ] The window opens over a game, with picture and sound
- [ ] Rotating the phone reshapes the window
- [ ] The phone volume slider changes only the phone's sound
- [ ] Stopping mirroring closes the window after a few seconds
- [ ] With "Approved phones (PIN)", the phone asks for the PIN and a notification shows it
- [ ] After the Deck sleeps and wakes, the phone can connect again

Streaming:
- [ ] YouTube plays in the window over a game (built-in engine)
- [ ] Netflix opens, **Browse & control** lets you log in and pick a show, and it plays in
      the window over a game (external engine)
- [ ] Play/pause, ±10 s, volume and mute work
- [ ] Stop closes everything, including the background browser

Window:
- [ ] Size presets, the snap grid and the sliders move and resize the window live
- [ ] Opening the Quick Access menu moves the window out of the way

### 2e. If something goes wrong

- **PiP Theater > Help > Check setup** shows which part fails.
- **Help > Save problem report** writes a text file to `~/Downloads`. Send me (Claude) its
  text and I'll help fix it.
- Plugin log: `~/homebrew/logs/PiP Theater/`
- Frontend console: in Decky Developer settings, enable **Allow Remote CEF Debugging**,
  then on your PC open Chrome > `chrome://inspect` > *Configure* > add `steamdeck:8081`
  (or your Deck's IP address) and inspect **SharedJSContext**.

### 2f. Tell people how to install

Put this in a Reddit post (r/SteamDeck, r/DeckyLoader) or anywhere else:

> 1. Decky > Settings > enable **Developer mode**.
> 2. Developer > **Install Plugin from URL** and paste:
>    `https://github.com/ColbyB03/pip-theater/releases/latest/download/pip-theater.zip`

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
  phone mirroring, and DRM support for Netflix/Disney+ via the external-browser engine.
- Read the review/testing page linked from the PR template:
  <https://wiki.deckbrew.xyz/plugin-dev/review-and-testing>

### 3b. Open the PR

1. **Fork** `decky-plugin-database` on GitHub (Fork button, top right).
2. Clone your fork and add your plugin:

```bash
git clone https://github.com/ColbyB03/decky-plugin-database.git
```

```bash
cd decky-plugin-database
```

```bash
git checkout -b add/pip-theater
```

```bash
git submodule add https://github.com/ColbyB03/pip-theater.git plugins/pip-theater
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
