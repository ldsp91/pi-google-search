# Google CSE Search Extension for pi

Web search tool for [pi](https://github.com/earendil-works/pi-coding-agent) using Google Custom Search Engine with a real Chrome browser fallback when rate-limited.

## Features

- **Primary:** Google CSE element API with token caching
- **Fallback:** Real Chrome browser via Playwright (persistent profile, stealth patches)
- Anti-detection: `navigator.webdriver` patch, chrome runtime spoofing, WebGL masking
- macOS-friendly: Chrome windows hidden, focus restored to terminal

## Setup

```bash
cd ~/agents/pi/extensions/google-cse-search
npm install
npx playwright install chromium
```

## Install as pi Extension

Add to your `settings.json`:

```json
{
  "extensions": ["~/agents/pi/extensions/google-cse-search"]
}
```

Or symlink into `~/.pi/agent/extensions/`:

```bash
ln -s ~/agents/pi/extensions/google-cse-search ~/.pi/agent/extensions/google-cse-search
```

## Requirements

- macOS (uses AppleScript to hide Chrome windows)
- Google Chrome installed at `/Applications/Google Chrome.app`
