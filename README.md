# Google CSE Search Extension for pi

Web search tool for [pi](https://github.com/earendil-works/pi-coding-agent) using Google Custom Search Engine (CSE) with a real Chrome browser fallback when the CSE rate limit is hit.

## The `web_search` Tool

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | The search query |
| `forceBrowser` | boolean (optional) | Skip the CSE API and use the browser fallback directly (useful for testing the fallback) |

Results are returned as a numbered list of titles, URLs, and snippets, with `details.source` indicating whether they came from `cse` or `browser-fallback`.

## How It Works

1. **Primary: Google CSE element API**
   - Fetches a CSE token from `cse.js` and caches it for **1 hour** (TTL) in `$TMPDIR/google_cse_token.json`, avoiding repeated fetches within the TTL window.
   - Searches via `cse.google.com/cse/element/v1` (top 10 results, `safe=off`).
2. **Fallback: real Chrome browser (Playwright)** — triggered when CSE hits its rate limit (HTTP 429), fails, or is explicitly skipped:
   - `forceBrowser: true` in the tool params, or the `CSE_FORCE_BROWSER` environment variable.
   - Uses the real Google Chrome binary (not Playwright's Chromium) in a **persistent, headed profile** at `$TMPDIR/google_search_profile`, so consent dialogs are handled only once.
   - Stealth patches applied to hide automation fingerprints: `navigator.webdriver` removal, plugins/languages spoofing, Chrome runtime spoofing, notification-permission override, WebGL vendor/renderer masking.
   - Handles Google consent dialogs and detects CAPTCHAs (throws an error if one appears).

## Install

### Via git (recommended)

```bash
pi install git:github.com/ldsp91/pi-google-search
```

pi clones the repo and runs `npm install` for you, so no manual setup is needed. Remove it later with:

```bash
pi remove git:github.com/ldsp91/pi-google-search
```

### Local checkout

Point pi at a local clone in your `settings.json`:

```json
{
  "extensions": ["~/agents/pi/extensions/google-cse-search"]
}
```

Or symlink into `~/.pi/agent/extensions/`:

```bash
ln -s ~/agents/pi/extensions/google-cse-search ~/.pi/agent/extensions/google-cse-search
```

For local installs, run `npm install` in the extension directory once (git installs do this automatically).

That's it — the browser fallback uses your system's Google Chrome, so `npx playwright install chromium` is **not** needed.

## Requirements

- Node.js (for the CSE API path — works on any platform)
- **For the browser fallback:**
  - macOS or Windows
  - Google Chrome installed:
    - **macOS:** `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
    - **Windows:** discovered via the registry (`App Paths\chrome.exe`) or common install locations
  - On macOS, AppleScript is used to keep the Chrome window behind the terminal (iTerm2/iTerm) and restore focus after the search.
  - On Windows, the Chrome window is launched off-screen (`--window-position=-32000,-32000`).
- **Linux (incl. sandboxes/containers):** Google Chrome or Chromium installed, plus a display. In display-less environments (containers, headless VMs) install `xvfb` and the extension starts a virtual display automatically (see below).

### Sandbox / headless Linux setup

The browser fallback is **headed** by design (headless Chrome gets caught by Google). Inside a sandbox with no display, Chrome renders to a virtual X server instead:

```bash
# one-time, as root inside the sandbox:
bash scripts/install-chrome.sh
```

This installs Google Chrome + Xvfb (Debian/Ubuntu bases). At runtime the extension:

1. detects that `DISPLAY` is unset,
2. starts `Xvfb :99` (falls back to :100–:110 if busy) with a 1920×1080 screen,
3. launches real headed Chrome against it, and
4. kills Xvfb on session shutdown.

Notes:

- Works in Docker/VM sandboxes because Chrome runs with `--no-sandbox --disable-dev-shm-usage`.
- If you already run an X server (e.g. `xvfb-run` or a forwarded display), set `DISPLAY` and Xvfb is skipped.
- Chromium-only systems are supported via auto-discovery of `/usr/bin/chromium*`.
- The sandbox's own IP reputation still applies — Google may rate-limit datacenter IPs regardless of headed/headless.

## Configuration

| Environment variable | Description |
|----------------------|-------------|
| `CSE_CHROME_PATH` | Override the Chrome executable location (checked first during discovery) |
| `CSE_FORCE_BROWSER` | When set, always skip the CSE API and use the browser fallback |
| `DISPLAY` | Use this X display instead of auto-starting Xvfb (Linux) |
