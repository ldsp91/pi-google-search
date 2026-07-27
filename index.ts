/**
 * Google CSE Search Extension
 *
 * Provides a web_search tool that leverages Google Custom Search Engine.
 * Falls back to a real Chrome browser (Playwright) when the CSE rate limit is hit.
 * Token caching avoids repeated fetches within the token TTL window.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserContext, chromium, type } from 'playwright';
import { Type } from 'typebox';

const CX = "partner-pub-8993703457585266:4862972284";
const TOKEN_TTL = 3600_000; // 1 hour in ms
const TOKEN_CACHE_PATH = join(tmpdir(), "google_cse_token.json");
const BROWSER_PROFILE_DIR = join(tmpdir(), "google_search_profile");

// Lazily-initialized persistent context (real Chrome profile, no headless)
let contextInstance: Promise<BrowserContext> | null = null;

function getContext(): Promise<BrowserContext> {
  if (!contextInstance) {
    contextInstance = chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
      ],
    });
  }
  return contextInstance;
}

/** Apply stealth patches to a page to hide automation fingerprints. */
async function applyStealth(page: import("playwright").Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    delete (navigator as Record<string, unknown>).plugins;
    delete (navigator as Record<string, unknown>).languages;
    (navigator as Record<string, unknown>).plugins = {
      0: { description: "PDF Viewer" },
      1: { description: "Chrome PDF Plugin" },
      length: 2,
    } as PluginArray;
    (navigator as Record<string, unknown>).languages = [
      "en-US",
      "en",
    ] as readonly string[];
    (window as Record<string, unknown>).chrome = {
      runtime: {
        onMessage: { addListener: () => {}, removeListener: () => {} },
        onConnect: { addListener: () => {}, removeListener: () => {} },
      },
    };
    const originalQuery = (navigator as any).permissions?.query;
    if (originalQuery) {
      (navigator as any).permissions.query = async function (
        request: PermissionsQuery,
      ): Promise<PermissionStatus> {
        if (request.name === "notifications") {
          return { state: "denied" } as PermissionStatus;
        }
        return originalQuery.call(navigator.permissions, request);
      };
    }
    Object.defineProperty(navigator, "plugins", {
      get: () => ({
        0: { name: "Chrome PDF Plugin" },
        1: { name: "Chrome PDF Viewer" },
        2: { name: "Native Client" },
        length: 3,
      }),
    });
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param: number) {
      const value = getParameter.call(this, param);
      if (param === 37445) return "Intel Inc.";
      if (param === 37446) return "Intel Iris OpenGL Engine";
      return value;
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

  const hideChrome = () => {
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

    // Restore focus to iTerm (async, after tool returns)
    setImmediate(() => {
      try {
        execSync('osascript -e "tell application \"iTerm\" to activate"', {
          timeout: 5000,
        });
      } catch {}
    });

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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let results: any[] = [];
      let source = "cse";

      try {
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
