/**
 * Google CSE Search Extension
 *
 * Provides a web_search tool that leverages Google Custom Search Engine.
 * Falls back to a real Chrome browser (Playwright) when the CSE rate limit is hit.
 * Token caching avoids repeated fetches within the token TTL window.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChildProcess, execSync, spawn, type } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserContext, chromium, LaunchOptions, type } from 'playwright';
import { Type } from 'typebox';

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

const CX = "partner-pub-8993703457585266:4862972284";
const TOKEN_TTL = 3_600_000; // 1 hour in ms
const TOKEN_CACHE_PATH = join(tmpdir(), "google_cse_token.json");
// Fixed path on Linux so a Dockerfile can bake a pre-warmed profile into
// the image at exactly the location the extension will use.
const BROWSER_PROFILE_DIR = IS_LINUX
  ? "/tmp/google_search_profile"
  : join(tmpdir(), "google_search_profile");

/**
 * Locate the real Chrome binary.
 * Order: CSE_CHROME_PATH env override -> OS-specific discovery.
 */
function findChrome(): string | null {
  const override = process.env.CSE_CHROME_PATH;
  if (override && existsSync(override)) return override;

  if (IS_WIN) {
    // Most reliable: registry App Paths entry (set by Chrome installer)
    try {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const m = out.match(/REG_SZ\s+(.+?\.exe)\s*$/im);
      if (m && existsSync(m[1].trim())) return m[1].trim();
    } catch {}
    // Common install locations
    const candidates = [
      join(
        process.env["ProgramFiles"] ?? "C:\\Program Files",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      join(
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      join(
        process.env["LOCALAPPDATA"] ?? "",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (found) return found;
    return null;
  }

  if (IS_MAC) {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    return existsSync(mac) ? mac : null;
  }

  if (IS_LINUX) {
    const candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  // Other platforms: no built-in discovery
  return null;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/**
 * Start an Xvfb server on the first free virtual display (:99-:110) so
 * headful Chrome can render inside display-less environments (containers,
 * sandboxes). Returns null when Xvfb is not installed.
 */
async function startXvfb(): Promise<{
  display: string;
  proc: ChildProcess;
} | null> {
  try {
    execSync("which Xvfb", { stdio: "ignore" });
  } catch {
    return null;
  }

  for (let n = 99; n <= 110; n++) {
    const lockPath = join("/tmp", `.X${n}-lock`);
    if (existsSync(lockPath)) continue;

    const display = `:${n}`;
    const socketPath = join("/tmp", ".X11-unix", `X${n}`);
    const proc = spawn(
      "Xvfb",
      [display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
      { stdio: "ignore" },
    );

    // Resolve as soon as the socket appears, the process dies, or 5s pass.
    const up = await Promise.race([
      waitFor(() => existsSync(socketPath), 5000, 100),
      new Promise<boolean>((resolve) => {
        proc.once("exit", () => resolve(false));
        proc.once("error", () => resolve(false));
      }),
    ]);
    if (!up) {
      try {
        proc.kill();
      } catch {}
      continue;
    }
    return { display, proc };
  }
  return null;
}

// Lazily-initialized persistent context (real Chrome profile, no headless)
let contextInstance: Promise<BrowserContext> | null = null;
let xvfbProc: ChildProcess | null = null;

async function getContext(): Promise<BrowserContext> {
  if (contextInstance) return contextInstance;

  const executable = findChrome();
  if (!executable) {
    throw new Error(
      "Google Chrome not found. Install Chrome (e.g. scripts/install-chrome.sh) or set the CSE_CHROME_PATH env var to its executable.",
    );
  }

  // Headful Chrome needs a display. In display-less Linux environments
  // (containers, sandboxes) fall back to a virtual Xvfb display so the real
  // headful browser can render off-screen.
  let display = process.env.DISPLAY;
  if (IS_LINUX && !display) {
    const xvfb = await startXvfb();
    if (xvfb) {
      display = xvfb.display;
      xvfbProc = xvfb.proc;
    } else {
      throw new Error(
        "No DISPLAY set and Xvfb not available. Install Xvfb in the sandbox (e.g. apt-get install -y xvfb) or provide a display.",
      );
    }
  }

  // A real user's browser always reports the timezone of the region their
  // egress IP points to. Display-less Linux environments default to UTC,
  // which disagrees with the IP's geography and reads as bot-like, so on
  // Linux we pin the browser to the user's timezone (CSE_TIMEZONE; default
  // Europe/Berlin — the sandbox's egress region).
  const timezoneId = IS_LINUX
    ? (process.env.CSE_TIMEZONE ?? "Europe/Berlin")
    : undefined;

  // A previously killed/crashed session can leave a live Chrome holding
  // this profile (orphaned when its node process died) plus a
  // SingletonLock; launching then would hang waiting for the other
  // instance. Clear both before launching.
  if (process.platform !== "win32") {
    try {
      execSync(`pkill -f '${BROWSER_PROFILE_DIR}' 2>/dev/null || true`, {
        stdio: "ignore",
      });
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  try {
    const lockPath = join(BROWSER_PROFILE_DIR, "SingletonLock");
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {}

  const launchOptions: LaunchOptions = {
    executablePath: executable,
    headless: false,
    timeout: 30000,
    ...(timezoneId ? { timezoneId } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      ...(IS_LINUX ? ["--disable-dev-shm-usage"] : []),
      ...(IS_WIN ? ["--window-position=-32000,-32000"] : []),
    ],
  };
  if (display || timezoneId) {
    launchOptions.env = {
      ...process.env,
      ...(display ? { DISPLAY: display } : {}),
      ...(timezoneId ? { TZ: timezoneId } : {}),
    };
  }

  contextInstance = chromium
    .launchPersistentContext(BROWSER_PROFILE_DIR, launchOptions)
    .catch((err) => {
      // Reset so the next call can retry (e.g. after fixing the environment)
      contextInstance = null;
      if (xvfbProc) {
        try {
          xvfbProc.kill();
        } catch {}
        xvfbProc = null;
      }
      throw err;
    });
  return contextInstance;
}

/** Apply stealth patches to a page to hide automation fingerprints. */
async function applyStealth(page: import("playwright").Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", {
      get: () => ({
        0: { name: "Chrome PDF Plugin" },
        1: { name: "Chrome PDF Viewer" },
        2: { name: "Native Client" },
        length: 3,
      }),
    });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"] as readonly string[],
    });
    (window as Record<string, unknown>).chrome = {
      runtime: {
        onMessage: { addListener: () => {}, removeListener: () => {} },
        onConnect: { addListener: () => {}, removeListener: () => {} },
      },
    };
  });
}

interface TokenCache {
  token: CSEToken;
  expiresAt: number;
}

interface CSEToken {
  cse_tok: string;
  cselibv: string;
  exp: string;
  usqp: string;
  fexp: string;
}

function loadCachedToken(): CSEToken | null {
  if (!existsSync(TOKEN_CACHE_PATH)) return null;
  try {
    const cache: TokenCache = JSON.parse(
      readFileSync(TOKEN_CACHE_PATH, "utf8"),
    );
    if (Date.now() > cache.expiresAt) return null;
    return cache.token;
  } catch {
    return null;
  }
}

function saveToken(token: CSEToken): void {
  writeFileSync(
    TOKEN_CACHE_PATH,
    JSON.stringify({ token, expiresAt: Date.now() + TOKEN_TTL }),
  );
}

async function fetchToken(): Promise<CSEToken> {
  const resp = await fetch(`https://www.google.com/cse/cse.js?cx=${CX}`);
  const text = await resp.text();
  const start = text.lastIndexOf("({");
  const end = text.lastIndexOf("});");
  const data = JSON.parse(text.slice(start + 1, end + 1));
  return {
    cse_tok: data.cse_token,
    cselibv: data.cselibVersion ?? "",
    exp: Array.isArray(data.exp) ? data.exp.join(",") : "",
    usqp: data.usqp ?? "",
    fexp: Array.isArray(data.fexp) ? data.fexp.join(",") : "",
  };
}

async function getToken(): Promise<CSEToken> {
  const cached = loadCachedToken();
  if (cached) return cached;
  const token = await fetchToken();
  saveToken(token);
  return token;
}

async function searchCSE(query: string, token: CSEToken): Promise<any[]> {
  const params = new URLSearchParams({
    rsz: "filtered_cse",
    num: "10",
    hl: "en",
    cselibv: token.cselibv,
    cx: CX,
    q: query,
    safe: "off",
    callback: "_",
    rurl: "https://www.google.com/search",
    searchtype: "",
    cse_tok: token.cse_tok,
    usqp: token.usqp,
  });
  if (token.exp) params.set("exp", token.exp);
  if (token.fexp) params.set("fexp", token.fexp);

  const url = `https://cse.google.com/cse/element/v1?${params.toString()}`;
  const resp = await fetch(url, {
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `https://cse.google.com/cse.js?cx=${CX}`,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Cookie: "CONSENT=YES+",
    },
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(
      `HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`,
    );
  }

  const data = JSON.parse(
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  );

  if (data.error?.code === 429) {
    throw new Error("Google CSE rate limit hit");
  }

  return data.results ?? [];
}

/**
 * Fallback: search Google via a real Chrome browser (Playwright).
 */
async function searchWithBrowser(query: string): Promise<any[]> {
  const context = await getContext();
  const page = await context.newPage();
  await applyStealth(page);

  // macOS only: bring the terminal forward to cover the Chrome window.
  // On Windows the window is launched off-screen instead (see getContext).
  const hideChrome = () => {
    if (!IS_MAC) return;
    try {
      execSync(
        `osascript -e 'tell application "iTerm2" to activate' -e 'tell application "iTerm2" to select current window'`,
        { timeout: 5000 },
      );
    } catch {}
  };
  hideChrome();

  try {
    await page.goto(
      `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`,
      {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      },
    );

    await page.waitForTimeout(3000);
    hideChrome();

    // Handle consent dialogs
    const consentSelectors = [
      'fluent-button[aria-label*="Accept"]',
      "button#L2AGLb",
      'div[role="dialog"] button',
      "center > div > button",
    ];
    for (const selector of consentSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(2000);
        break;
      }
    }

    // Check for CAPTCHA
    const captchaVisible = await page
      .locator('#captcha-container, .g-recaptcha, div[role="dialog"]')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (captchaVisible) {
      throw new Error("Google showed a CAPTCHA");
    }

    hideChrome();

    // Restore focus to iTerm (macOS only, async, after tool returns)
    if (IS_MAC) {
      setImmediate(() => {
        try {
          execSync('osascript -e "tell application \"iTerm\" to activate"', {
            timeout: 5000,
          });
        } catch {}
      });
    }

    const results = await page.evaluate(() => {
      const results: Array<{
        titleNoFormatting: string;
        unescapedUrl: string;
        url: string;
        contentNoFormatting: string;
      }> = [];

      const search = document.getElementById("search");
      if (!search) return results;

      const h3s = search.querySelectorAll("h3");
      h3s.forEach((h3) => {
        const title = h3.textContent?.trim() ?? "";
        if (!title) return;

        // Walk up to find the result container
        let container = h3.parentElement;
        let depth = 0;
        while (container && depth < 8) {
          let snippetEl = container.querySelector("[data-sncf]");
          let snippet = "";
          if (!snippetEl) {
            const allDivs = container.querySelectorAll("div");
            for (const d of allDivs) {
              if (d.querySelector("a")) continue; // skip breadcrumbs
              const text = d.textContent?.trim() ?? "";
              if (text.length > 50 && text !== title) {
                snippetEl = d as HTMLElement;
                snippet = text.replace(/\.{3}\s*Read more$/i, "").slice(0, 300);
                break;
              }
            }
          } else {
            snippet = (snippetEl.textContent?.trim() ?? "")
              .replace(/\.{3}\s*Read more$/i, "")
              .slice(0, 300);
          }

          if (snippetEl) {
            const linkEl = container.querySelector("a[href]");
            const href = linkEl?.getAttribute("href") ?? "";
            let url = href;
            try {
              url = new URL(href).searchParams.get("q") ?? href;
            } catch {}
            if (!url || url === "about:blank") return;

            results.push({
              titleNoFormatting: title,
              unescapedUrl: url,
              url,
              contentNoFormatting: snippet,
            });
            return;
          }
          container = container.parentElement;
          depth++;
        }
      });

      return results;
    });

    return results;
  } finally {
    await page.close();
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    if (contextInstance) {
      try {
        await (await contextInstance).close();
      } catch {}
      contextInstance = null;
    }
    if (xvfbProc) {
      try {
        xvfbProc.kill();
      } catch {}
      xvfbProc = null;
    }
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Google Custom Search Engine. Falls back to a browser when rate-limited. Returns titles, URLs, and snippets for the top results.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use web_search when you need current information from the web, such as documentation, news, or facts that may have changed recently.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      forceBrowser: Type.Optional(
        Type.Boolean({
          description:
            "Skip the CSE API and use the browser fallback directly (useful for testing the fallback).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let results: any[] = [];
      let source = "cse";

      try {
        // Skip CSE and use the browser fallback when explicitly requested
        if (params.forceBrowser || process.env.CSE_FORCE_BROWSER) {
          throw new Error("CSE skipped (forceBrowser)");
        }
        const token = await getToken();
        results = await searchCSE(params.query, token);
        source = "cse";
      } catch (cseErr) {
        try {
          results = await searchWithBrowser(params.query);
          source = "browser-fallback";
        } catch (browserErr) {
          return {
            content: [
              {
                type: "text",
                text: `Search failed: ${cseErr instanceof Error ? cseErr.message : String(cseErr)}`,
              },
            ],
            details: {},
          };
        }
      }

      if (results.length === 0) {
        return {
          content: [
            { type: "text", text: `No results found for: ${params.query}` },
          ],
          details: { results: [], source },
        };
      }

      const lines = [
        `Found ${results.length} results for "${params.query}" (${source}):`,
      ];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const title = r.titleNoFormatting ?? "N/A";
        const url = r.unescapedUrl ?? r.url ?? "N/A";
        const snippet = (r.contentNoFormatting ?? "").slice(0, 300);
        lines.push(`${i + 1}. ${title}`);
        lines.push(`   URL: ${url}`);
        if (snippet) lines.push(`   ${snippet}`);
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: results.map((r) => ({
            title: r.titleNoFormatting,
            url: r.unescapedUrl ?? r.url,
          })),
          source,
        },
      };
    },
  });
}
