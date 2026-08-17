#!/usr/bin/env bash
#
# One-time setup for running the CSE browser fallback inside a sandbox
# (Docker container, headless VM, ...) with NO display attached.
#
# Installs:
#   - Google Chrome (headful build, not headless-shell)
#   - Xvfb (virtual display; the extension starts it automatically when DISPLAY is unset)
#   - A realistic font set (fontconfig + DejaVu/Liberation/Roboto; a bare
#     container's 16 fonts is itself a bot signal for fingerprint checks)
#
# Requires: Debian/Ubuntu base image, root access.
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root inside the sandbox (e.g. docker exec -it <container> bash scripts/install-chrome.sh)" >&2
  exit 1
fi

apt-get update -y
apt-get install -y --no-install-recommends wget ca-certificates xvfb \
  fontconfig fonts-dejavu-core fonts-liberation fonts-roboto
fc-cache -f >/dev/null 2>&1 || true

# --- Google Chrome ---
if ! command -v google-chrome >/dev/null 2>&1 && [ ! -x /opt/google/chrome/chrome ]; then
  ARCH="$(dpkg --print-architecture)"
  wget -qO /tmp/google-chrome.deb \
    "https://dl.google.com/linux/direct/google-chrome-stable_current_${ARCH}.deb"
  apt-get install -y /tmp/google-chrome.deb
  rm -f /tmp/google-chrome.deb
fi

echo "--- installed ---"
google-chrome --no-sandbox --version
command -v Xvfb
echo "fonts: $(fc-list 2>/dev/null | wc -l)"

echo ""
echo "Done. The web_search extension will now:"
echo "  - find Chrome at /usr/bin/google-chrome"
echo "  - start Xvfb on :99 automatically when DISPLAY is unset"
echo ""
echo "Optional overrides:"
echo "  CSE_CHROME_PATH=/path/to/chrome   use a different executable"
echo "  DISPLAY=:99                       reuse an existing X display instead of Xvfb"
