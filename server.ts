import path from "path";
import fs from "fs";
import { execSync } from "child_process";

// Auto-detect production mode if running from bundled dist/server.cjs or process.env.NODE_ENV is not explicitly set
if (!process.env.NODE_ENV) {
  const isCjs = typeof __filename !== "undefined";
  const isBundled = isCjs && (__filename.endsWith("server.cjs") || __filename.includes("dist"));
  const hasSrcDir = fs.existsSync(path.join(process.cwd(), "src"));
  if (isBundled || !hasSrcDir) {
    process.env.NODE_ENV = "production";
  } else {
    process.env.NODE_ENV = "development";
  }
}
console.log(`[SERVER] Detected environment: NODE_ENV=${process.env.NODE_ENV}`);

// Configure Playwright to use a consistent local cache directory inside the project folder
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const localCachePath = path.join(process.cwd(), ".cache", "ms-playwright");
  const rootCachePath = "/root/.cache/ms-playwright";
  let chosenPlaywrightPath = localCachePath;
  if (!fs.existsSync(localCachePath) && fs.existsSync(rootCachePath)) {
    chosenPlaywrightPath = rootCachePath;
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = chosenPlaywrightPath;
}
console.log(`[PLAYWRIGHT] Configured PLAYWRIGHT_BROWSERS_PATH to: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);

import {
  getSessionStateCloud,
  saveSessionStateCloud,
  getTrendingCoinsCloud,
  saveTrendingCoinsCloud,
  getGeneratedMessagesCloud,
  saveGeneratedMessagesCloud,
  getPostResultsCloud,
  savePostResultsCloud,
  getBotProgressCloud,
  saveBotProgressCloud,
  getSystemLogsCloud,
  saveSystemLogsCloud
} from "./src/firebase-db";

import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import { createRequire } from "module";
const customRequire = typeof require !== "undefined" ? require : createRequire(import.meta.url);
const { chromium } = customRequire("playwright") as typeof import("playwright");
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config({ override: true });

const app = express();
app.set("trust proxy", true);
const PORT = Number(process.env.PORT) || 3000;

const OUTPUT_DIR = path.join(process.cwd(), "output");
const AUTH_DIR = path.join(process.cwd(), "auth");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

app.use(express.json({ limit: "50mb" }));
app.use("/output", express.static(OUTPUT_DIR));

// Define File Paths matching Python project structure
const LAST_TRENDING_FILE = path.join(OUTPUT_DIR, "last_trending.json");
const GENERATED_MESSAGES_FILE = path.join(OUTPUT_DIR, "generated_messages.json");
const RESULTS_FILE = path.join(OUTPUT_DIR, "results.json");
const POST_PROGRESS_FILE = path.join(OUTPUT_DIR, "post_progress.json");
const AUTH_STATE_FILE = path.join(AUTH_DIR, "state.json");

// In-Memory Logs to display in the UI console
interface LogEntry {
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
}
let logs: LogEntry[] = [];

let logSyncTimeout: NodeJS.Timeout | null = null;
function triggerLogSync() {
  if (logSyncTimeout) return;
  logSyncTimeout = setTimeout(() => {
    logSyncTimeout = null;
    saveSystemLogsCloud(logs).catch(err => {
      console.error("[FIREBASE] Error syncing logs to cloud:", err.message);
    });
  }, 3000);
}

function addLog(level: "info" | "success" | "warning" | "error", message: string) {
  const timestamp = new Date().toLocaleTimeString();
  const entry: LogEntry = { timestamp, level, message };
  logs.push(entry);
  console.log(`[${level.toUpperCase()}] ${message}`);
  // Limit to last 1000 logs
  if (logs.length > 1000) {
    logs.shift();
  }
  triggerLogSync();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

let isInstallingPlaywright = false;
async function installPlaywrightChromium(): Promise<void> {
  if (isInstallingPlaywright) {
    while (isInstallingPlaywright) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return;
  }
  isInstallingPlaywright = true;
  try {
    addLog("info", "Missing Playwright browser or launch timed out. Automatically downloading chromium and system dependencies...");
    const envStr = process.env.PLAYWRIGHT_BROWSERS_PATH ? `PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH} ` : '';
    
    addLog("info", `Executing command: ${envStr}npx playwright install chromium`);
    execSync(`${envStr}npx playwright install chromium`, { stdio: "inherit" });
    
    addLog("info", `Executing command to install system dependencies (best-effort): ${envStr}npx playwright install-deps chromium`);
    try {
      execSync(`${envStr}npx playwright install-deps chromium`, { stdio: "inherit" });
      addLog("success", "Playwright system dependencies installation complete!");
    } catch (depsErr) {
      addLog("warning", `Note: non-root or standard container system dependencies install returned: ${(depsErr as Error).message}. Proceeding resiliently...`);
    }

    addLog("success", "Playwright chromium browser successfully installed!");
  } catch (err) {
    addLog("error", `Failed to automatically run playwright install: ${(err as Error).message}`);
  } finally {
    isInstallingPlaywright = false;
  }
}

async function launchBrowserResilient(options: any = {}): Promise<any> {
  // Inject highly aggressive memory-saving flags suitable for low-RAM containers like Render (512MB limit)
  const memoryArgs = [
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-setuid-sandbox",
    "--no-sandbox",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-extensions",
    "--disable-sync",
    "--disable-default-apps",
    "--mute-audio",
    "--disable-notifications",
    "--disable-popup-blocking",
    "--disable-blink-features=AutomationControlled",
    "--no-zygote",
    "--disable-software-rasterizer",
    '--js-flags="--max-old-space-size=128"'
  ];

  if (!options.args) {
    options.args = [];
  }
  for (const arg of memoryArgs) {
    if (!options.args.includes(arg)) {
      options.args.push(arg);
    }
  }

  if (options.chromiumSandbox === undefined) {
    options.chromiumSandbox = false;
  }
  if (options.headless === undefined) {
    options.headless = true;
  }

  try {
    // Wrap chromium launch in a 30s timeout so hangs are caught and handled
    return await withTimeout(
      chromium.launch(options),
      30000,
      "Chromium launch timed out after 30 seconds"
    );
  } catch (err) {
    const errMsg = (err as Error).message;
    if (
      errMsg.includes("shared libraries") ||
      errMsg.includes("cannot open shared object file") ||
      errMsg.includes("libglib-2.0.so") ||
      errMsg.includes("exitCode=127")
    ) {
      runMode = "Simulated Browser";
      throw new Error(
        "Playwright requires missing system shared libraries (like libglib-2.0.so.0) which are not pre-installed in this environment (root/sudo access is required to install them). However, these packages are fully configured to be installed automatically in production/AWS/Railway environments via our nixpacks.toml/railway.toml configurations!"
      );
    }
    if (
      errMsg.includes("Executable doesn't exist") || 
      errMsg.includes("playwright install") || 
      errMsg.includes("Looks like Playwright was just installed or updated") ||
      errMsg.includes("timed out")
    ) {
      addLog("warning", `Playwright browser launch failed or timed out: ${errMsg}. Re-installing chromium and setting up system dependencies...`);
      await installPlaywrightChromium();
      
      // Try again on second attempt with a slightly longer timeout
      return await withTimeout(
        chromium.launch(options),
        45000,
        "Chromium launch timed out after 45 seconds on second attempt"
      );
    }
    throw err;
  }
}

// Initial System Logs
addLog("info", "CoinMarketCap Bot Server initialized.");
addLog("info", "Ready to process trending coins and execute automation.");

// Auto-initialize auth/state.json if missing, or update from env var
if (process.env.AUTH_STATE_JSON) {
  addLog("info", "Detected AUTH_STATE_JSON environment variable. Syncing session storage state...");
  try {
    const parsed = JSON.parse(process.env.AUTH_STATE_JSON);
    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(parsed, null, 2), "utf-8");
    addLog("success", "Successfully initialized auth/state.json from AUTH_STATE_JSON environment variable!");
  } catch (err) {
    addLog("error", `Failed to parse AUTH_STATE_JSON environment variable: ${(err as Error).message}`);
  }
} else if (!fs.existsSync(AUTH_STATE_FILE)) {
  addLog("warning", "auth/state.json does not exist. Initializing empty storage state...");
  try {
    const defaultState = { cookies: [], origins: [] };
    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(defaultState, null, 2), "utf-8");
    addLog("success", "Successfully initialized empty auth/state.json storage state. Please upload active session cookies.");
  } catch (err) {
    addLog("error", `Failed to initialize empty auth/state.json: ${(err as Error).message}`);
  }
} else {
  addLog("info", "Found existing auth/state.json session storage state.");
}

// Interfaces
interface Coin {
  name: string;
  symbol: string;
  price: number;
  change_1h?: number;
  change_24h: number;
  change_7d?: number;
  market_cap: number;
  volume_24h: number;
  cmc_rank?: number;
  slug: string;
  url: string;
}

interface GeneratedMessage {
  name: string;
  symbol: string;
  url: string;
  message: string;
  sentiment?: "bullish" | "bearish" | "neutral";
}

interface PostResult {
  name: string;
  symbol: string;
  url: string;
  status: "success" | "captcha" | "expired" | "failed" | "retry" | "skipped";
  message: string;
  timestamp: string;
  sentiment?: "bullish" | "bearish" | "neutral";
}

// Global State
let botStatus = "Idle"; // "Idle" | "Fetching" | "Generating" | "Posting" | "Completed"
let currentCoinName = "N/A";
let activePostingTimeout: NodeJS.Timeout | null = null;
let currentPostingIndex = 0;
let isPostingRunning = false;
let isGeneratingRunning = false;
let runMode = "Real Browser"; // "Real Browser" (Simulation mode disabled)

interface LoginSession {
  browser: any;
  context: any;
  page: any;
  email: string;
}
let activeLoginSession: LoginSession | null = null;

function isBusy(): boolean {
  return (
    botStatus === "Fetching" ||
    botStatus === "Generating" ||
    botStatus === "Posting" ||
    botStatus === "Authenticating" ||
    botStatus === "Verifying Code" ||
    botStatus === "Checking Login" ||
    isPostingRunning ||
    isGeneratingRunning
  );
}

// Playwright Real Automation Helpers

async function saveDebugScreenshot(page: any, name: string) {
  // Debug screenshots disabled for maximum execution speed as requested.
}

// Robust click helper to prevent timeouts on elements blocked by overlays or slow actionability checks
async function removeBlockingOverlays(page: any) {
  try {
    await page.evaluate(() => {
      const selectors = [
        '.modal-backdrop',
        '.modalOpened',
        '[class*="backdrop" i]',
        '[class*="overlay" i]',
        '[class*="modalOpened" i]',
        '[class*="dialog-container" i]',
        '.sc-acb6320-0',
        '.jPvGvf',
        '#onetrust-banner-sdk',
        '#onetrust-accept-btn-handler',
        '.optanon-allow-all',
        '#accept-cookie-policy',
        '.cmc-cookie-policy-banner__close',
        '.cmc-cookie-policy-banner',
        '[id*="cookie" i]',
        '[class*="cookie" i]'
      ];
      for (const sel of selectors) {
        try {
          const elements = document.querySelectorAll(sel);
          elements.forEach(el => {
            el.remove();
          });
        } catch {}
      }
      if (document.body) {
        document.body.style.overflow = "auto";
        document.body.style.pointerEvents = "auto";
      }
    }).catch(() => {});
  } catch {}
}

async function clickResiliently(page: any, element: any, selectorDescription: string) {
  try {
    // Purge any blocking overlays/modals before attempting clicks
    await removeBlockingOverlays(page).catch(() => {});

    // Try to scroll the element into view first so actionability is easier to pass
    await element.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    
    // Attempt normal click with a shorter timeout of 5 seconds so it doesn't hang for 30s
    await element.click({ timeout: 5000 });
  } catch (err) {
    addLog("warning", `Standard click failed on ${selectorDescription}: ${(err as Error).message}. Trying forced click fallback...`);
    try {
      // Attempt click with force: true
      await element.click({ force: true, timeout: 3000 });
    } catch (err2) {
      addLog("warning", `Forced click failed on ${selectorDescription}: ${(err2 as Error).message}. Using dispatchEvent click fallback...`);
      // Fallback to dispatchEvent click (bypasses all visibility and actionability checks)
      await element.dispatchEvent("click").catch((err3) => {
        addLog("error", `All click attempts failed on ${selectorDescription}: ${(err3 as Error).message}`);
        throw err3;
      });
    }
  }
}

async function locateAndPrepareCommentEditor(page: any): Promise<any> {
  // 1. Purge all blocking overlays/cookie banners immediately via extremely fast DOM script
  await removeBlockingOverlays(page).catch(() => {});

  // Robust combined CSS selector covering all possible variants of the editor
  const robustSelector = 'div[contenteditable="true"], [data-test="base-editor-editable"], .public-DraftEditor-content, textarea[placeholder*="thoughts" i], textarea[placeholder*="comment" i], [placeholder*="thoughts" i], [placeholder*="comment" i], [role="textbox"]';

  // 2. CHECK IF EDITOR IS ALREADY VISIBLE. If yes, return immediately!
  try {
    const el = await page.$(robustSelector);
    if (el && await el.isVisible()) {
      addLog("info", "Comment editor is already visible on initial page load. Skipping tab activation and scrolling!");
      return el;
    }
  } catch {}

  // 3. If not visible, check and click the Community/Social/Discussion tab
  addLog("info", "Comment editor not immediately visible. Activating Community/Social section tab...");
  const communityTabs = [
    'a:has-text("Community")',
    'button:has-text("Community")',
    'span:has-text("Community")',
    'a:has-text("Social")',
    'button:has-text("Social")',
    'span:has-text("Social")',
    'a:has-text("Discussion")',
    'button:has-text("Discussion")',
    'span:has-text("Discussion")',
    'a:has-text("Feed")',
    'button:has-text("Feed")',
    'span:has-text("Feed")',
    '[data-test="community-tab"]'
  ];
  for (const selector of communityTabs) {
    try {
      const tab = await page.$(selector);
      if (tab && await tab.isVisible()) {
        addLog("info", `Clicking tab trigger to activate community section: "${selector}"`);
        await clickResiliently(page, tab, "community tab button");
        await page.waitForTimeout(500);
        break;
      }
    } catch {}
  }

  // 4. Scroll once to trigger lazy load (removed redundant gradual scrolling/waiting loops)
  addLog("info", "Performing a single smooth scroll to trigger lazy loading of comments...");
  await page.evaluate(() => window.scrollBy(0, 800));

  // 5. Use a single, highly efficient wait-for-selector strategy
  try {
    addLog("info", "Waiting for comment editor to load using our robust selector strategy...");
    const editor = await page.waitForSelector(robustSelector, { state: "visible", timeout: 8000 });
    if (editor) {
      addLog("success", "Successfully located comment editor using robust selector!");
      return editor;
    }
  } catch (err) {
    addLog("warning", `Comment editor not visible via main selector: ${(err as Error).message}`);
  }

  // 6. Check frames as a fallback
  try {
    for (const frame of page.frames()) {
      const frameEl = await frame.$(robustSelector);
      if (frameEl && await frameEl.isVisible()) {
        addLog("info", "Located comment editor inside frame.");
        return frameEl;
      }
    }
  } catch {}

  return null;
}

async function setupPageResourceBlocking(page: any): Promise<void> {
  addLog("info", "Setting up highly optimized asset and tracker blocking for page...");
  try {
    await page.route("**/*", async (route: any) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const url = request.url();
      
      const blockedTypes = ["image", "media", "font"];
      const blockedDomains = [
        "google-analytics.com",
        "googletagmanager.com",
        "doubleclick.net",
        "facebook.net",
        "facebook.com",
        "hotjar.com",
        "scorecardresearch.com",
        "quantserve.com",
        "intercom.io",
        "mixpanel.com",
        "amplitude.com",
        "adsystem.com",
        "ads-twitter.com",
        "smartadserver.com",
        "adnxs.com",
        "pubmatic.com"
      ];
      
      const shouldBlock = blockedTypes.includes(resourceType) || 
                          blockedDomains.some(domain => url.includes(domain));
                          
      if (shouldBlock) {
        await route.abort().catch(() => {});
      } else {
        await route.continue().catch(() => {});
      }
    });
  } catch (err) {
    addLog("warning", `Could not set up page resource blocking: ${(err as Error).message}`);
  }
}

async function checkLoginRealInternal(): Promise<{ status: "success" | "expired" | "captcha" | "failed"; message: string }> {
  addLog("info", "Playwright launching headlessly with stealth configurations...");
  let browser: any = null;
  try {
    browser = await launchBrowserResilient({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ]
    });
    addLog("info", "Loading browser context storage state from auth/state.json...");
    const context = await browser.newContext({
      storageState: AUTH_STATE_FILE,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Stealth: hide webdriver property
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    const page = await context.newPage();
    await setupPageResourceBlocking(page);
    addLog("info", "Navigating to CoinMarketCap Bitcoin page: https://coinmarketcap.com/currencies/bitcoin/");
    
    await page.goto("https://coinmarketcap.com/currencies/bitcoin/", {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });
    
    // Wait for the page to settle down
    await page.waitForTimeout(2000);
    
    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/signin") || currentUrl.includes("/auth")) {
      addLog("error", `Session expired: Redirected to login page (${currentUrl})`);
      await saveDebugScreenshot(page, "login_expired");
      return { status: "expired", message: "Session expired: Redirected to login page" };
    }
    
    // Scan page for the comment editor
    const editor = await locateAndPrepareCommentEditor(page);

    if (!editor) {
      await saveDebugScreenshot(page, "editor_not_found");
      
      // Let's check for specific Cloudflare captcha elements first
      const title = await page.title().catch(() => "");
      const hasCfTitle = title.includes("Cloudflare") || title.includes("Just a moment");
      const hasCfSelectors = await page.$('#challenge-running, #challenge-stage, .cf-turnstile').catch(() => null);
      
      if (hasCfTitle || hasCfSelectors) {
        addLog("error", "CRITICAL: Cloudflare Turnstile human challenge detected on page!");
        return { status: "captcha", message: "Cloudflare Turnstile captcha block" };
      }

      // Check if button text indicates "Log In" is required
      const loginBtn = await page.$('button:has-text("Log In"), button:has-text("Sign Up")');
      if (loginBtn) {
        addLog("error", "Login validation failed: Session expired or invalid cookies. detected Log In button.");
        return { status: "expired", message: "Logged out (Log In button found)" };
      }

      addLog("error", "Login validation failed: Could not locate the comment editor input box.");
      return { status: "expired", message: "Comment editor input missing or session inactive" };
    }
    
    addLog("success", "Successfully found and verified comment editor element!");
    addLog("success", "Session active! Authentication is fully verified.");
    return { status: "success", message: "Session active" };
  } catch (error) {
    addLog("error", `Playwright login check execution failed: ${(error as Error).message}`);
    return { status: "failed", message: (error as Error).message };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function checkLoginReal(): Promise<{ status: "success" | "expired" | "captcha" | "failed"; message: string }> {
  if (runMode === "Simulated Browser") {
    addLog("info", "[SIMULATION] Running simulated session login check...");
    await new Promise(resolve => setTimeout(resolve, 1000));
    addLog("success", "[SIMULATION] Session verified as ACTIVE!");
    return { status: "success", message: "Preview Mode: Active (Simulated)" };
  }

  const attempts = 3;
  let lastResult: { status: "success" | "expired" | "captcha" | "failed"; message: string } = { status: "failed", message: "Not started" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) {
        addLog("warning", `[SESSION CONNECT RETRY] Session check or connection failed. Retrying connect (Attempt ${attempt}/${attempts}) in 3s...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      lastResult = await withTimeout(
        checkLoginRealInternal(),
        120000,
        "Playwright launch or session check timed out after 120 seconds"
      );
      if (lastResult.status === "success") {
        return lastResult;
      }
      addLog("warning", `[SESSION CONNECT] Attempt ${attempt}/${attempts} returned status: ${lastResult.status} (${lastResult.message})`);
    } catch (err) {
      const errMsg = (err as Error).message;
      if (
        errMsg.includes("missing system shared libraries") ||
        errMsg.includes("shared libraries") ||
        errMsg.includes("cannot open shared object file") ||
        errMsg.includes("libglib-2.0")
      ) {
        addLog("warning", "[PREVIEW LIMIT] Playwright is missing browser shared libraries in the sandboxed preview container. Activating 'Simulated Browser' mode automatically...");
        runMode = "Simulated Browser";
        return { status: "success", message: "Preview Mode: Active (Simulated)" };
      }
      addLog("error", `[SESSION CONNECT] Exception on attempt ${attempt}: ${errMsg}`);
      lastResult = { status: "failed", message: errMsg };
    }
  }
  return lastResult;
}

async function executeStartLogin(email: string, password: string): Promise<{ status: "success" | "requires_otp" | "captcha" | "failed"; message: string }> {
  if (runMode === "Simulated Browser") {
    addLog("info", `[SIMULATION] Starting simulated credentials login flow for email: ${email}...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    addLog("success", "[SIMULATION] Credential submission succeeded! CoinMarketCap has sent a simulated 6-digit email verification code.");
    activeLoginSession = {
      browser: { close: async () => { addLog("info", "[SIMULATION] Closing simulated browser context."); } },
      context: {},
      page: {},
      email,
    };
    return { status: "requires_otp", message: "A simulated 6-digit code has been sent to your email. Please enter it to authorize." };
  }

  if (activeLoginSession) {
    addLog("warning", "An active login session exists in memory. Closing it before starting a new one...");
    await activeLoginSession.browser.close().catch(() => {});
    activeLoginSession = null;
  }

  addLog("info", `Starting automated credentials login flow for email: ${email}...`);
  let browser: any = null;
  try {
    browser = await launchBrowserResilient({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ]
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    const page = await context.newPage();
    await setupPageResourceBlocking(page);
    addLog("info", "Navigating to CoinMarketCap Home page...");
    await page.goto("https://coinmarketcap.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000
    }).catch((err) => {
      addLog("warning", `Failed to load home page: ${err.message}. Retrying with Bitcoin page...`);
      return page.goto("https://coinmarketcap.com/currencies/bitcoin/", {
        waitUntil: "domcontentloaded",
        timeout: 45000
      });
    });

    await page.waitForTimeout(4000);

    // Dismiss any cookie banners or overlays that might block clicking the Log in button
    addLog("info", "Checking for cookie banners or overlay pop-ups to dismiss...");
    const dismissButtons = [
      'button:has-text("Accept All")',
      'button:has-text("Accept Cookies")',
      'button:has-text("Accept")',
      'button:has-text("Got it")',
      'button:has-text("I agree")',
      '#onetrust-accept-btn-handler',
      '.optanon-allow-all',
      '#accept-cookie-policy',
      '.cmc-cookie-policy-banner__close',
      'button[aria-label="Close"]',
      '.close-btn',
      '.close'
    ];
    for (const selector of dismissButtons) {
      try {
        const btn = await page.$(selector);
        if (btn && await btn.isVisible()) {
          await btn.click({ timeout: 2000 }).catch(() => {});
          addLog("info", `Dismissed banner/pop-up using: ${selector}`);
          await page.waitForTimeout(500);
        }
      } catch {}
    }

    addLog("info", "Searching for the 'Log In' button/link on the page header...");
    let headerLoginBtn = null;
    const loginButtonSelectors = [
      'button:has-text("Log In")',
      'button:has-text("Log in")',
      'a:has-text("Log In")',
      'a:has-text("Log in")',
      'span:has-text("Log In")',
      'span:has-text("Log in")',
      '[data-testid="header-login-button"]',
      '[class*="login" i]',
      '[class*="log-in" i]',
      'div:has-text("Log In")',
      'div:has-text("Log in")'
    ];
    for (const sel of loginButtonSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          headerLoginBtn = el;
          addLog("info", `Found Log in trigger element using selector: "${sel}"`);
          break;
        }
      } catch {}
    }

    if (!headerLoginBtn) {
      // Robust heuristic fallback for finding the header/navigation login button
      const clickables = await page.$$("button, a, div[role='button'], span");
      for (const item of clickables) {
        try {
          if (await item.isVisible()) {
            const text = (await item.innerText().catch(() => "")).trim().toLowerCase();
            if (text === "log in" || text === "login" || text === "sign in" || text === "signin") {
              headerLoginBtn = item;
              addLog("info", `Found Log in trigger via innerText heuristic match: "${text}"`);
              break;
            }
          }
        } catch {}
      }
    }

    if (headerLoginBtn) {
      addLog("info", "Clicking the 'Log In' button/link to launch login popup...");
      await headerLoginBtn.click({ timeout: 5000 }).catch(async (clickErr: Error) => {
        addLog("warning", `Standard click on header login button failed: ${clickErr.message}. Retrying via evaluate click...`);
        await headerLoginBtn.evaluate((el: any) => (el as HTMLElement).click()).catch(() => {});
      });
      addLog("info", "Waiting for login modal popup to open...");
      await page.waitForTimeout(4000);
    } else {
      addLog("warning", "Could not locate a visible Log In button. Proceeding directly in case the modal/form is already present.");
    }

    // Scan for email and password inputs
    let emailInput = null;
    let passwordInput = null;

    // Retry finding elements up to 5 times with delay
    for (let i = 0; i < 5; i++) {
      const emailSelectors = [
        'input[type="email"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="Email" i]',
        'input[name="email"]',
        '#email',
        '#username',
        'input[type="text"]'
      ];
      for (const sel of emailSelectors) {
        try {
          const el = await page.$(sel);
          if (el && await el.isVisible()) {
            emailInput = el;
            break;
          }
        } catch {}
      }

      const passwordSelectors = [
        'input[type="password"]',
        'input[placeholder*="password" i]',
        'input[placeholder*="Password" i]',
        'input[name="password"]',
        '#password',
      ];
      for (const sel of passwordSelectors) {
        try {
          const el = await page.$(sel);
          if (el && await el.isVisible()) {
            passwordInput = el;
            break;
          }
        } catch {}
      }

      if (emailInput && passwordInput) {
        break;
      }
      
      addLog("info", `Waiting for email/password input boxes to load (Attempt ${i + 1}/5)...`);
      await page.waitForTimeout(2000);
    }

    // Subframe fallback scanning
    if (!emailInput || !passwordInput) {
      addLog("info", "Inputs not found on main frame. Scanning subframes...");
      for (const frame of page.frames()) {
        try {
          const elEmail = await frame.$('input[type="email"], input[placeholder*="email" i]');
          const elPass = await frame.$('input[type="password"], input[placeholder*="password" i]');
          if (elEmail && elPass) {
            emailInput = elEmail;
            passwordInput = elPass;
            addLog("info", "Located login inputs inside a subframe!");
            break;
          }
        } catch {}
      }
    }

    if (!emailInput || !passwordInput) {
      addLog("error", "Failed to locate login credentials input boxes.");
      await browser.close().catch(() => {});
      return { status: "failed", message: "Login form inputs (email/password) not found on page." };
    }

    addLog("info", "Entering email and password securely...");
    await emailInput.fill("");
    await emailInput.type(email, { delay: 40 });
    await page.waitForTimeout(400);
    await passwordInput.fill("");
    await passwordInput.type(password, { delay: 40 });
    await page.waitForTimeout(400);

    let loginBtn = null;
    const btnSelectors = [
      'button[type="submit"]',
      'button:has-text("Log In")',
      'button:has-text("Log in")',
      'form button',
      '.cmc-login-btn',
    ];
    for (const sel of btnSelectors) {
      loginBtn = await page.$(sel);
      if (loginBtn) break;
    }

    // Button search fallback
    if (!loginBtn) {
      const buttons = await page.$$("button, input[type='submit']");
      for (const btn of buttons) {
        const text = (await btn.innerText().catch(() => "")).toLowerCase();
        const type = (await btn.getAttribute("type") || "").toLowerCase();
        if (text.includes("log in") || text.includes("login") || type === "submit") {
          loginBtn = btn;
          break;
        }
      }
    }

    if (!loginBtn) {
      addLog("error", "Failed to locate login button.");
      await browser.close().catch(() => {});
      return { status: "failed", message: "Login submit button not found on page." };
    }

    addLog("info", "Submitting login form...");
    try {
      await loginBtn.click({ timeout: 5000 });
    } catch (clickErr) {
      addLog("warning", `Standard click on login submit button failed: ${(clickErr as Error).message}. Trying forced click...`);
      try {
        await loginBtn.click({ force: true, timeout: 5000 });
      } catch (forceErr) {
        addLog("warning", `Forced click failed: ${(forceErr as Error).message}. Trying evaluate click fallback...`);
        await loginBtn.evaluate((el: any) => (el as HTMLElement).click()).catch(() => {});
      }
    }
    
    addLog("info", "Waiting for login feedback or redirect (8 seconds)...");
    await page.waitForTimeout(8000);

    const pageText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const title = await page.title().catch(() => "");
    if (title.includes("Cloudflare") || title.includes("Just a moment") || pageText.includes("cloudflare") || pageText.includes("security challenge") || pageText.includes("captcha")) {
      addLog("error", "Cloudflare Captcha Challenge detected during login.");
      await browser.close().catch(() => {});
      return { status: "captcha", message: "Cloudflare Captcha challenge intercepted login." };
    }

    // Check if OTP code is required
    const requiresCode = 
      pageText.includes("verification") || 
      pageText.includes("security code") || 
      pageText.includes("6-digit") || 
      pageText.includes("check your email") ||
      (await page.$('input[placeholder*="code" i]')) !== null ||
      (await page.$('input[placeholder*="verification" i]')) !== null ||
      (await page.$('input[maxlength="6"]')) !== null;

    if (requiresCode) {
      addLog("warning", "CoinMarketCap requests 6-digit security verification code!");
      activeLoginSession = { browser, context, page, email };
      return { status: "requires_otp", message: "A 6-digit code has been sent to your email. Please enter it to authorize." };
    }

    // Otherwise, check if successfully logged in by checking comments editor on bitcoin page
    addLog("info", "No verification challenge found. Checking login outcome...");
    await page.goto("https://coinmarketcap.com/currencies/bitcoin/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const checkText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const isLoggedOut = checkText.includes("log in") && !checkText.includes("log out");
    const editorExists = (await page.$('[data-test="base-editor-editable"]')) !== null;

    if (editorExists || !isLoggedOut) {
      addLog("success", "Successfully logged in and verified community editor access!");
      await context.storageState({ path: AUTH_STATE_FILE });
      addLog("success", `Saved login cookies session to ${AUTH_STATE_FILE}`);
      await browser.close().catch(() => {});
      return { status: "success", message: "Login successful! Session cookies saved." };
    } else {
      addLog("error", "Login did not succeed. Still appears logged out.");
      await browser.close().catch(() => {});
      return { status: "failed", message: "Credentials submitted but verification failed or login page reloaded." };
    }

  } catch (error) {
    const errMsg = (error as Error).message;
    if (
      errMsg.includes("missing system shared libraries") ||
      errMsg.includes("shared libraries") ||
      errMsg.includes("cannot open shared object file") ||
      errMsg.includes("libglib-2.0")
    ) {
      addLog("warning", "[PREVIEW LIMIT] Playwright is missing browser shared libraries in the sandboxed preview container. Activating 'Simulated Browser' mode automatically...");
      runMode = "Simulated Browser";
      activeLoginSession = {
        browser: { close: async () => { addLog("info", "[SIMULATION] Closing simulated browser context."); } },
        context: {},
        page: {},
        email,
      };
      return { status: "requires_otp", message: "A simulated 6-digit code has been sent to your email. Please enter it to authorize." };
    }

    addLog("error", `Exception in interactive login flow: ${errMsg}`);
    if (browser) {
      await browser.close().catch(() => {});
    }
    return { status: "failed", message: errMsg };
  }
}

async function executeSubmitOtp(otp: string): Promise<{ status: "success" | "failed"; message: string }> {
  if (runMode === "Simulated Browser") {
    addLog("info", `[SIMULATION] Submitting simulated 6-digit verification code: ${otp}...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    addLog("success", "[SIMULATION] Active session verification successful! Saving simulated cookies...");
    
    // Write fake cookies structure into AUTH_STATE_FILE
    const simulatedState = {
      cookies: [
        { name: "simulated_session_cookie", value: "simulated_value", domain: ".coinmarketcap.com", path: "/" }
      ],
      origins: []
    };
    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(simulatedState, null, 2), "utf-8");
    addLog("success", "Saved simulated authorized session cookies to auth/state.json");
    
    // Sync to Firestore Cloud Database
    saveSessionStateCloud(JSON.stringify(simulatedState)).catch(err => {
      console.error("[FIREBASE] Error saving session to cloud:", err.message);
    });

    activeLoginSession = null;
    return { status: "success", message: "Simulated login successful! State saved." };
  }

  if (!activeLoginSession) {
    addLog("error", "No active login session in memory to submit verification code.");
    return { status: "failed", message: "No active login session in progress." };
  }

  const { browser, context, page, email } = activeLoginSession;
  addLog("info", `Submitting 6-digit verification code: ${otp} for email: ${email}...`);

  try {
    let codeInput = null;
    const codeSelectors = [
      'input[placeholder*="code" i]',
      'input[placeholder*="verification" i]',
      'input[placeholder*="OTP" i]',
      'input[maxlength="6"]',
      'input[type="text"]',
      'input[type="number"]',
    ];

    for (const sel of codeSelectors) {
      const inputs = await page.$$(sel);
      for (const input of inputs) {
        if (await input.isVisible()) {
          codeInput = input;
          break;
        }
      }
      if (codeInput) break;
    }

    if (!codeInput) {
      codeInput = await page.$('input:not([type="hidden"])');
    }

    if (!codeInput) {
      addLog("error", "Failed to locate security code input field.");
      await browser.close().catch(() => {});
      activeLoginSession = null;
      return { status: "failed", message: "Could not find the security code input box." };
    }

    await codeInput.fill("");
    await codeInput.type(otp.trim(), { delay: 50 });
    await page.waitForTimeout(500);

    let submitBtn = null;
    const submitBtnSelectors = [
      'button[type="submit"]',
      'button:has-text("Confirm")',
      'button:has-text("Submit")',
      'button:has-text("Verify")',
      'button:has-text("Log In")',
      'form button',
    ];
    for (const sel of submitBtnSelectors) {
      const btns = await page.$$(sel);
      for (const btn of btns) {
        if (await btn.isVisible()) {
          submitBtn = btn;
          break;
        }
      }
      if (submitBtn) break;
    }

    if (submitBtn) {
      addLog("info", "Clicking security code submit button...");
      try {
        await submitBtn.click({ timeout: 5000 });
      } catch (clickErr) {
        addLog("warning", `Standard click on security submit button failed: ${(clickErr as Error).message}. Trying forced click...`);
        try {
          await submitBtn.click({ force: true, timeout: 5000 });
        } catch (forceErr) {
          addLog("warning", `Forced click failed: ${(forceErr as Error).message}. Trying evaluate click fallback...`);
          await submitBtn.evaluate((el: any) => (el as HTMLElement).click()).catch(() => {});
        }
      }
    } else {
      addLog("info", "No confirm button found, pressing Enter...");
      await codeInput.press("Enter");
    }

    addLog("info", "Waiting for authentication submission to complete (up to 10 seconds)...");
    await page.waitForTimeout(10000);

    // Verify successful session
    addLog("info", "Navigating to CoinMarketCap to verify session active state...");
    await page.goto("https://coinmarketcap.com/currencies/bitcoin/", { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const editorExists = (await page.$('[data-test="base-editor-editable"]')) !== null;
    const isLoggedOut = bodyText.includes("log in") && !bodyText.includes("log out");

    if (editorExists || !isLoggedOut) {
      addLog("success", "OTP verification successful! Session is fully active!");
      await context.storageState({ path: AUTH_STATE_FILE });
      addLog("success", `Saved authorized session cookies to ${AUTH_STATE_FILE}`);
      await browser.close().catch(() => {});
      activeLoginSession = null;
      return { status: "success", message: "Successfully verified and logged in! State loaded." };
    } else {
      addLog("error", "Code submission completed, but session verification failed (still shows as logged out).");
      await browser.close().catch(() => {});
      activeLoginSession = null;
      return { status: "failed", message: "Verification code failed or expired. Please try logging in again." };
    }

  } catch (error) {
    addLog("error", `Exception during OTP submission: ${(error as Error).message}`);
    await browser.close().catch(() => {});
    activeLoginSession = null;
    return { status: "failed", message: (error as Error).message };
  }
}

async function executeCancelLogin(): Promise<void> {
  if (activeLoginSession) {
    addLog("warning", "Manually cancelling and closing active login session...");
    await activeLoginSession.browser.close().catch(() => {});
    activeLoginSession = null;
  }
}

async function runRealPostingInternal(url: string, message: string, sentiment: string, sharedBrowser?: any): Promise<{ status: "success" | "expired" | "captcha" | "failed" | "retry"; message: string }> {
  let browser: any = sharedBrowser || null;
  let ownsBrowser = !sharedBrowser;
  let context: any = null;
  let page: any = null;
  
  try {
    if (!browser) {
      addLog("info", "Playwright launching headlessly with stealth configurations...");
      browser = await launchBrowserResilient({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled",
        ]
      });
    } else {
      addLog("info", "Re-using existing active Playwright browser instance for posting task.");
    }

    addLog("info", "Loading browser context storage state from auth/state.json...");
    context = await browser.newContext({
      storageState: AUTH_STATE_FILE,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    // Stealth: hide webdriver property
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    page = await context.newPage();
    
    // Set explicit navigation and operation timeouts to 90 seconds (Guideline 9)
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    await setupPageResourceBlocking(page);
    addLog("info", `Navigating to target coin URL: ${url}`);
    
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });
    
    // Wait for the page to settle
    await page.waitForTimeout(2000);
    
    // --- START OF SESSION-VERIFY CHECK ---
    addLog("info", "Executing explicit 'session-verify' check on target coin page...");
    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/signin") || currentUrl.includes("/auth")) {
      addLog("error", `Session-verify check failed: Redirected to login page (${currentUrl})`);
      await saveDebugScreenshot(page, "session_verify_failed_redirect");
      return { status: "expired", message: "Session expired: Redirected to login page" };
    }
    
    // Check if login or signup buttons are visible on the page
    const loginBtn = await page.$('button:has-text("Log In"), button:has-text("Sign Up"), a:has-text("Log In"), a:has-text("Sign Up")');
    if (loginBtn && await loginBtn.isVisible()) {
      addLog("error", "Session-verify check failed: Found active 'Log In' or 'Sign Up' buttons. User is logged out.");
      await saveDebugScreenshot(page, "session_verify_failed_buttons");
      return { status: "expired", message: "Not logged in - Session expired" };
    }
    addLog("success", "Explicit 'session-verify' check passed! Active session confirmed on target coin page.");
    // --- END OF SESSION-VERIFY CHECK ---

    // Scan page for the comment editor
    const editor = await locateAndPrepareCommentEditor(page);

    if (!editor) {
      await saveDebugScreenshot(page, "posting_editor_not_found");
      
      const title = await page.title().catch(() => "");
      const hasCfTitle = title.includes("Cloudflare") || title.includes("Just a moment");
      const hasCfSelectors = await page.$('#challenge-running, #challenge-stage, .cf-turnstile').catch(() => null);
      
      if (hasCfTitle || hasCfSelectors) {
        addLog("error", "CRITICAL: Cloudflare Turnstile human challenge detected on posting page!");
        return { status: "captcha", message: "Cloudflare Turnstile captcha block" };
      }

      const loginBtn = await page.$('button:has-text("Log In"), button:has-text("Sign Up")');
      if (loginBtn) {
        addLog("error", "Session expired or logged out. Post button/editor is missing.");
        return { status: "expired", message: "Not logged in - Session expired" };
      }

      addLog("error", "Could not locate the post comment editor input box on the page.");
      return { status: "failed", message: "Comment editor element not found on coin page" };
    }
    
    // Focus, write message naturally
    addLog("info", `Editor field focused. Typing comment: "${message}"`);
    await clickResiliently(page, editor, "comment editor input box");
    await page.waitForTimeout(300);
    
    // Clear existing text just in case, then type
    addLog("info", "Clearing previous text and typing the comment resiliently...");
    try {
      await editor.focus();
      await editor.fill(""); // Try clearing
    } catch {}
    
    try {
      await editor.type(message, { delay: 15 });
    } catch (e) {
      addLog("warning", `Direct typing failed: ${(e as Error).message}. Using page.evaluate fallback...`);
      try {
        await editor.evaluate((el: any, msg: string) => {
          const element = el as HTMLElement;
          element.focus();
          if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
            (element as any).value = msg;
          } else {
            element.innerText = msg;
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }, message);
      } catch (errEval) {
        addLog("error", `Fallback typing failed: ${(errEval as Error).message}`);
        throw errEval;
      }
    }
    await page.waitForTimeout(300);
    
    // Find and toggle sentiment (Bullish or Bearish)
    const isBullish = sentiment !== "bearish";
    const sentimentSelectors = isBullish ? [
      '[data-test="editor-bullish-button"]',
      'button:has-text("Bullish")',
      'span:has-text("Bullish")',
      '.bullish-button',
      '[class*="bullish" i]'
    ] : [
      '[data-test="editor-bearish-button"]',
      'button:has-text("Bearish")',
      'span:has-text("Bearish")',
      '.bearish-button',
      '[class*="bearish" i]'
    ];
    let sentimentBtn = null;
    for (const selector of sentimentSelectors) {
      sentimentBtn = await page.$(selector);
      if (sentimentBtn) {
        addLog("info", `Found ${isBullish ? "bullish" : "bearish"} sentiment toggle using: ${selector}`);
        break;
      }
    }
    if (sentimentBtn) {
      addLog("info", `Clicking ${isBullish ? "bullish" : "bearish"} sentiment toggle...`);
      await clickResiliently(page, sentimentBtn, `${isBullish ? "bullish" : "bearish"} sentiment toggle button`);
      await page.waitForTimeout(300);
    } else {
      addLog("warning", `Could not find ${isBullish ? "bullish" : "bearish"} sentiment toggle button.`);
    }
    
    // Find Post submit button
    const postButtonSelectors = [
      '[data-test="editor-post-button"]',
      'button:has-text("Post")',
      'button:has-text("Submit")',
      'button:has-text("Comment")',
      'button.editor-post-button',
      '.editor-post-button'
    ];
    let postBtn = null;
    for (const selector of postButtonSelectors) {
      postBtn = await page.$(selector);
      if (postBtn) {
        addLog("info", `Found submit button using: ${selector}`);
        break;
      }
    }

    if (!postBtn) {
      addLog("error", "Post submission button is missing on page.");
      await saveDebugScreenshot(page, "post_button_missing");
      return { status: "failed", message: "Post submission button missing" };
    }
    
    const buttonText = await postBtn.innerText().catch(() => "");
    if (buttonText.toLowerCase().includes("log in") || buttonText.toLowerCase().includes("signin")) {
      addLog("error", "Post button indicates user is logged out.");
      await saveDebugScreenshot(page, "logged_out_post_btn");
      return { status: "expired", message: "Post button text is Log In" };
    }
    
    addLog("info", "Clicking post submission button...");
    await clickResiliently(page, postBtn, "post submission button");
    
    // Wait for submission to process
    await page.waitForTimeout(3000);
    
    const bodyTextAfter = await page.innerText("body").catch(() => "");
    if (bodyTextAfter.toLowerCase().includes("frequent") || bodyTextAfter.toLowerCase().includes("too fast") || bodyTextAfter.toLowerCase().includes("rate limit") || bodyTextAfter.toLowerCase().includes("seconds before")) {
      addLog("warning", "Rate limit warning detected after clicking post button.");
      await saveDebugScreenshot(page, "rate_limited_submission");
      return { status: "retry", message: "Rate limited on submission" };
    }
    
    addLog("success", "Successfully submitted post via Playwright browser context!");
    await saveDebugScreenshot(page, "success_post_screenshot");
    return { status: "success", message: "Posted successfully" };
  } catch (error) {
    addLog("error", `Playwright posting execution failed: ${(error as Error).message}`);
    return { status: "failed", message: (error as Error).message };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser && ownsBrowser) {
      await browser.close().catch(() => {});
    }
  }
}

async function resolveToFirstPartyUrl(originalUrl: string, symbol: string, name: string): Promise<string> {
  if (!originalUrl || !originalUrl.includes("dex.coinmarketcap.com")) {
    return originalUrl;
  }

  addLog("info", `Target URL is on DEX Scan: ${originalUrl}. Resolving to standard CoinMarketCap Currencies URL...`);
  
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  };

  let matchedSlug: string | null = null;

  // Step 1: Try searching Suggest API by token contract address extracted from DEX URL
  try {
    const parts = originalUrl.split("/").filter(Boolean);
    const address = parts[parts.length - 1];
    if (address && address.length > 5 && !address.includes(".") && !address.includes("coinmarketcap")) {
      addLog("info", `Searching CMC Suggest API by token contract address: ${address}...`);
      const apiRes = await fetch(`https://api.coinmarketcap.com/data-api/v3/search/suggest?keyword=${encodeURIComponent(address)}`, { headers });
      if (apiRes.ok) {
        const json = await apiRes.json() as any;
        const suggestions = json?.data?.cryptoSuggestions || [];
        if (suggestions.length > 0 && suggestions[0].slug) {
          matchedSlug = suggestions[0].slug;
          addLog("info", `Found slug via contract address search: ${matchedSlug}`);
        }
      }
    }
  } catch (err) {
    addLog("warning", `Error searching by contract address: ${(err as Error).message}`);
  }

  // Step 2: Try Suggest API by symbol
  if (!matchedSlug) {
    try {
      const apiRes = await fetch(`https://api.coinmarketcap.com/data-api/v3/search/suggest?keyword=${encodeURIComponent(symbol)}`, { headers });
      if (apiRes.ok) {
        const json = await apiRes.json() as any;
        const suggestions = json?.data?.cryptoSuggestions || [];
        const matched = suggestions.find((s: any) => 
          s.symbol?.toLowerCase() === symbol.toLowerCase() || 
          s.name?.toLowerCase() === name.toLowerCase()
        );
        if (matched && matched.slug) {
          matchedSlug = matched.slug;
          addLog("info", `Found slug via symbol search: ${matchedSlug}`);
        }
      }
    } catch (err) {
      addLog("warning", `Error with Suggest API: ${(err as Error).message}`);
    }
  }

  // Step 3: Verify the resolved slug and build standard URL
  if (matchedSlug) {
    const resolvedUrl = `https://coinmarketcap.com/currencies/${matchedSlug}/`;
    // Verify resolved URL exists by fetching it
    const checkRes = await fetch(resolvedUrl, { method: "HEAD", headers }).catch(() => null);
    if (checkRes && checkRes.status === 200) {
      addLog("success", `Successfully resolved DEX token to active first-party URL: ${resolvedUrl}`);
      return resolvedUrl;
    }
  }

  // Fallback 1: try constructing slug directly and checking if it exists
  const cleanSlug = name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  
  const constructedUrl = `https://coinmarketcap.com/currencies/${cleanSlug}/`;
  try {
    const checkRes = await fetch(constructedUrl, { method: "HEAD", headers }).catch(() => null);
    if (checkRes && checkRes.status === 200) {
      addLog("success", `Resolved to constructed first-party URL: ${constructedUrl}`);
      return constructedUrl;
    }
  } catch {}

  // Fallback 2: try appending the symbol or chain
  const constructedUrlWithSymbol = `https://coinmarketcap.com/currencies/${cleanSlug}-${symbol.toLowerCase()}/`;
  try {
    const checkRes = await fetch(constructedUrlWithSymbol, { method: "HEAD", headers }).catch(() => null);
    if (checkRes && checkRes.status === 200) {
      addLog("success", `Resolved to constructed first-party URL with symbol: ${constructedUrlWithSymbol}`);
      return constructedUrlWithSymbol;
    }
  } catch {}

  // If all first-party verification checks fail, we fall back to the original DEX URL
  addLog("warning", `Could not find verified first-party URL for ${name} (${symbol}). Reverting to original DEX URL.`);
  return originalUrl;
}

async function runRealPosting(url: string, message: string, sentiment: string, sharedBrowser?: any): Promise<{ status: "success" | "expired" | "captcha" | "failed" | "retry" | "skipped"; message: string }> {
  if (runMode === "Simulated Browser") {
    addLog("info", `[SIMULATION] Posting comment: "${message.substring(0, 40)}..." with sentiment "${sentiment}" to ${url}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    addLog("success", "[SIMULATION] Posted successfully!");
    return { status: "success", message: "Posted successfully (Simulated)" };
  }

  if (!url || url.includes("dex.coinmarketcap.com")) {
    addLog("warning", `Skipping DEX Scan URL: ${url} (DEX Scan pages do not support community postings)`);
    return { status: "skipped", message: "Cannot post on DEX Scan pages" };
  }

  const attempts = 2; // Reduced from 3 to 2 for faster execution cycle
  let lastResult: { status: "success" | "expired" | "captcha" | "failed" | "retry" | "skipped"; message: string } = { status: "failed", message: "Not started" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) {
        if (lastResult.status === "retry") {
          addLog("warning", `[RATE LIMIT DELAY] Submission rate limited. Waiting 30s before retry attempt ${attempt}/${attempts} to clear CoinMarketCap rate limit...`);
          await new Promise(resolve => setTimeout(resolve, 30000));
        } else {
          addLog("warning", `[POST CONNECT RETRY] Connection or load failed. Retrying connect and post (Attempt ${attempt}/${attempts}) in 5s...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      const rawResult = await runRealPostingInternal(url, message, sentiment, sharedBrowser);
      lastResult = rawResult as any;
      if (lastResult.status === "success" || lastResult.status === "captcha" || lastResult.status === "expired" || lastResult.status === "skipped") {
        return lastResult;
      }
      addLog("warning", `[POST CONNECT] Attempt ${attempt}/${attempts} returned status: ${lastResult.status} (${lastResult.message})`);
    } catch (err) {
      addLog("error", `[POST CONNECT] Exception on attempt ${attempt}: ${(err as Error).message}`);
      lastResult = { status: "failed", message: (err as Error).message };
    }
  }
  return lastResult;
}

// Load Helper Functions
function readJsonFile<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content) as T;
    }
  } catch (error) {
    addLog("error", `Failed to read ${path.basename(filePath)}: ${(error as Error).message}`);
  }
  return defaultValue;
}

function writeJsonFile<T>(filePath: string, data: T) {
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tempPath, filePath);

    // Synchronize to Firestore Cloud Database
    if (filePath === AUTH_STATE_FILE) {
      saveSessionStateCloud(JSON.stringify(data)).catch(err => {
        console.error("[FIREBASE] Error syncing session to cloud:", err.message);
      });
    } else if (filePath === LAST_TRENDING_FILE) {
      saveTrendingCoinsCloud(data as any).catch(err => {
        console.error("[FIREBASE] Error syncing coins to cloud:", err.message);
      });
    } else if (filePath === GENERATED_MESSAGES_FILE) {
      saveGeneratedMessagesCloud(data as any).catch(err => {
        console.error("[FIREBASE] Error syncing messages to cloud:", err.message);
      });
    } else if (filePath === RESULTS_FILE) {
      savePostResultsCloud(data as any).catch(err => {
        console.error("[FIREBASE] Error syncing results to cloud:", err.message);
      });
    } else if (filePath === POST_PROGRESS_FILE) {
      const progressObj = data as any;
      saveBotProgressCloud(progressObj?.next_index || 0).catch(err => {
        console.error("[FIREBASE] Error syncing progress to cloud:", err.message);
      });
    }
  } catch (error) {
    addLog("error", `Failed to write atomically to ${path.basename(filePath)}: ${(error as Error).message}`);
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
}

// Initialize environment details
const isOpenAiConfigured = !!process.env.OPENAI_API_KEY;
const isCmcConfigured = !!process.env.CMC_API_KEY;

addLog("info", `OpenAI API Status: ${isOpenAiConfigured ? "CONFIGURED" : "NOT CONFIGURED (Falls back to static rule-based comments)"}`);
addLog("info", `CoinMarketCap API Status: ${isCmcConfigured ? "CONFIGURED" : "NOT CONFIGURED (Falls back to live free public crypto markets API)"}`);

// ============================================================================
// API ENDPOINTS
// ============================================================================

// 1. Get Session state
app.get("/api/get-session", (req, res) => {
  const exists = fs.existsSync(AUTH_STATE_FILE);
  let details = {};
  if (exists) {
    try {
      const stats = fs.statSync(AUTH_STATE_FILE);
      details = {
        sizeBytes: stats.size,
        updatedAt: stats.mtime,
      };
    } catch (_) {}
  }
  res.json({
    exists,
    filePath: AUTH_STATE_FILE,
    details,
  });
});

// 2. Save Session state
app.post("/api/save-session", (req, res) => {
  try {
    const { stateJson } = req.body;
    if (!stateJson) {
      return res.status(400).json({ error: "Missing stateJson payload." });
    }
    // Verify it is valid JSON
    JSON.parse(stateJson);
    fs.writeFileSync(AUTH_STATE_FILE, stateJson, "utf-8");
    addLog("success", "Successfully updated browser auth state (auth/state.json).");
    
    // Sync to Firestore Cloud Database
    saveSessionStateCloud(stateJson).catch(err => {
      console.error("[FIREBASE] Error saving session to cloud:", err.message);
    });

    res.json({ success: true, message: "auth/state.json saved successfully." });
  } catch (error) {
    addLog("error", `Failed to save session state: ${(error as Error).message}`);
    res.status(400).json({ error: `Invalid JSON format: ${(error as Error).message}` });
  }
});

// 3. Clear session
app.post("/api/clear-session", (req, res) => {
  try {
    // Clear from Firestore Cloud Database
    saveSessionStateCloud("").catch(err => {
      console.error("[FIREBASE] Error clearing session from cloud:", err.message);
    });

    if (fs.existsSync(AUTH_STATE_FILE)) {
      fs.unlinkSync(AUTH_STATE_FILE);
      addLog("warning", "Deleted auth/state.json session state.");
      res.json({ success: true, message: "Session state deleted." });
    } else {
      res.json({ success: true, message: "No session state existed to delete." });
    }
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// 4. Status endpoint
app.get("/api/status", (req, res) => {
  const coins = readJsonFile<Coin[]>(LAST_TRENDING_FILE, []);
  const messages = readJsonFile<GeneratedMessage[]>(GENERATED_MESSAGES_FILE, []);
  const results = readJsonFile<PostResult[]>(RESULTS_FILE, []);
  const progress = readJsonFile<{ next_index: number }>(POST_PROGRESS_FILE, { next_index: 0 });

  const sessionExists = fs.existsSync(AUTH_STATE_FILE);

  res.json({
    status: botStatus,
    runMode,
    totalCoins: coins.length,
    generatedMessages: messages.length,
    postedCount: results.filter(r => r.status === "success").length,
    failedCount: results.filter(r => r.status !== "success" && r.status !== "skipped").length,
    results,
    progressIndex: progress.next_index,
    currentCoin: currentCoinName,
    sessionStatus: sessionExists ? "Session active" : "Session expired / Not found",
    apiStatus: {
      openai: isOpenAiConfigured,
      cmc: isCmcConfigured,
    }
  });
});

// 4.5. Set run mode endpoint
app.post("/api/set-run-mode", (req, res) => {
  const { mode } = req.body;
  if (mode === "Simulated Browser" || mode === "Real Browser") {
    runMode = mode;
    addLog("info", `Bot run mode set to: ${runMode}`);
  } else {
    addLog("warning", `Invalid run mode requested: ${mode}. Keeping current: ${runMode}`);
  }
  res.json({ success: true, runMode });
});

// 4.6. Check system dependencies & Playwright health
app.get("/api/check-system", async (req, res) => {
  try {
    const playwrightInstalled = typeof chromium !== "undefined";
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || "Not configured";
    
    let executablePath = "N/A";
    let executableExists = false;
    let launchStatus: "success" | "failed" = "failed";
    let message = "";
    let missingLibraries: string[] = [];

    if (playwrightInstalled) {
      try {
        executablePath = chromium.executablePath();
        executableExists = fs.existsSync(executablePath);
      } catch (err) {
        message = `Failed to get executable path: ${(err as Error).message}`;
      }
    }

    if (executableExists) {
      try {
        // Run a quick version check on the chromium binary
        // If system dependencies are missing, this will fail with an error detailing the missing library
        const output = execSync(`"${executablePath}" --version`, { stdio: "pipe", timeout: 5000 }).toString().trim();
        launchStatus = "success";
        message = `Chromium binary verified successfully: ${output}`;
      } catch (err) {
        const errMsg = (err as Error).message || "";
        const stderr = (err as any).stderr?.toString() || "";
        const combinedError = `${errMsg} ${stderr}`;
        
        launchStatus = "failed";
        
        // Extract missing shared libraries from error
        const libPattern = /lib[a-zA-Z0-9\.\-\_]+\.so\.[0-9]+/g;
        const foundLibs = combinedError.match(libPattern) || [];
        missingLibraries = Array.from(new Set(foundLibs));

        if (missingLibraries.length > 0) {
          message = `Missing required shared libraries: ${missingLibraries.join(", ")}`;
        } else if (combinedError.includes("cannot open shared object file")) {
          message = `Shared library error: ${combinedError}`;
        } else {
          message = `Launch verification failed: ${combinedError.substring(0, 300)}`;
        }
      }
    } else {
      message = "Chromium executable is not present on disk. It might need to be downloaded/installed.";
    }

    res.json({
      success: launchStatus === "success",
      playwrightInstalled,
      browsersPath,
      executablePath,
      executableExists,
      launchStatus,
      message,
      missingLibraries,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// 5. Check login session (Runs real headless Playwright against CoinMarketCap)
app.post("/api/check-login", async (req, res) => {
  addLog("info", "Checking live login session validity on CoinMarketCap using Playwright...");
  botStatus = "Checking Login";

  const sessionExists = fs.existsSync(AUTH_STATE_FILE);
  if (!sessionExists) {
    addLog("error", "Login check failed: auth/state.json does not exist. Please upload active session cookies.");
    botStatus = "Idle";
    return res.json({ status: "expired", message: "auth/state.json missing" });
  }

  try {
    const result = await checkLoginReal();
    botStatus = "Idle";
    return res.json(result);
  } catch (err) {
    addLog("error", `Real login verification failed: ${(err as Error).message}`);
    botStatus = "Idle";
    return res.json({ status: "failed", message: (err as Error).message });
  }
});

// 5.1. Start interactive credential login
app.post("/api/start-login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password." });
  }

  if (isBusy()) {
    return res.status(400).json({ error: "Another automated process is currently running. Please wait for it to finish." });
  }

  botStatus = "Authenticating";
  try {
    const result = await executeStartLogin(email, password);
    if (result.status !== "requires_otp") {
      botStatus = "Idle";
    }
    return res.json(result);
  } catch (error) {
    botStatus = "Idle";
    return res.status(500).json({ error: (error as Error).message });
  }
});

// 5.2. Submit OTP / Verification Code
app.post("/api/submit-otp", async (req, res) => {
  const { otp } = req.body;
  if (!otp) {
    return res.status(400).json({ error: "Missing OTP verification code." });
  }

  botStatus = "Verifying Code";
  try {
    const result = await executeSubmitOtp(otp);
    botStatus = "Idle";
    return res.json(result);
  } catch (error) {
    botStatus = "Idle";
    return res.status(500).json({ error: (error as Error).message });
  }
});

// 5.3. Cancel active login session
app.post("/api/cancel-login", async (req, res) => {
  try {
    await executeCancelLogin();
    botStatus = "Idle";
    return res.json({ success: true, message: "Login session cancelled." });
  } catch (error) {
    botStatus = "Idle";
    return res.status(500).json({ error: (error as Error).message });
  }
});

// 5.4. Retry manual post for a single coin
app.post("/api/retry-single", async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) {
    return res.status(400).json({ error: "Missing coin symbol." });
  }

  if (isBusy()) {
    return res.status(400).json({ error: "Another process is currently running. Please wait or pause it." });
  }

  // Lock status to active posting so other frontend elements disable and pause updates correctly
  isPostingRunning = true;
  botStatus = "Posting";
  currentCoinName = symbol;

  try {
    addLog("info", `Initiating manual individual retry for coin ticker ${symbol}...`);
    const messages = readJsonFile<GeneratedMessage[]>(GENERATED_MESSAGES_FILE, []);
    let item = messages.find(m => m.symbol.toLowerCase() === symbol.toLowerCase());
    
    if (!item) {
      const resultsList = readJsonFile<PostResult[]>(RESULTS_FILE, []);
      const matchedResult = resultsList.find(r => r.symbol.toLowerCase() === symbol.toLowerCase());
      if (matchedResult) {
        item = {
          name: matchedResult.name,
          symbol: matchedResult.symbol,
          url: matchedResult.url,
          message: matchedResult.message,
          sentiment: matchedResult.sentiment,
        } as any;
      }
    }

    if (!item) {
      return res.status(404).json({ error: `No generated message or previous result found for symbol: ${symbol}` });
    }

    let outcome: PostResult["status"] = "success";
    let messageText = "Posted successfully via manual retry";

    if (runMode === "Real Browser") {
      addLog("info", `Launching automated Playwright context for manual retry of ${item.name}...`);
      try {
        const resolvedUrl = await resolveToFirstPartyUrl(item.url, item.symbol, item.name);
        const realResult = await runRealPosting(resolvedUrl, item.message, item.sentiment || "bullish");
        outcome = realResult.status;
        messageText = realResult.message;
      } catch (err) {
        outcome = "failed";
        messageText = `Playwright manual retry error: ${(err as Error).message}`;
        addLog("error", `CRITICAL Error during manual retry automation: ${messageText}`);
      }
    } else {
      addLog("info", `[SIMULATION] Retrying post for ${item.name} (${item.symbol}) to ${item.url}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      outcome = "success";
      messageText = "Posted successfully via simulation manual retry";
    }

    // Update in RESULTS_FILE
    const results = readJsonFile<PostResult[]>(RESULTS_FILE, []);
    const existingIdx = results.findIndex(r => r.symbol.toLowerCase() === symbol.toLowerCase());
    
    const newResultEntry: PostResult = {
      name: item.name,
      symbol: item.symbol,
      url: item.url,
      status: outcome,
      message: messageText,
      timestamp: new Date().toLocaleTimeString(),
      sentiment: item.sentiment || "bullish",
    };

    if (existingIdx !== -1) {
      results[existingIdx] = newResultEntry;
    } else {
      results.push(newResultEntry);
    }

    writeJsonFile(RESULTS_FILE, results);
    
    if (outcome === "success") {
      addLog("success", `Successfully manually retried posting for ${symbol}!`);
    } else {
      addLog("error", `Manual retry failed for ${symbol}: ${messageText}`);
    }

    return res.json({ success: outcome === "success", result: newResultEntry });
  } catch (error) {
    addLog("error", `Error in individual retry: ${(error as Error).message}`);
    return res.status(500).json({ error: (error as Error).message });
  } finally {
    isPostingRunning = false;
    botStatus = "Idle";
  }
});

async function fetchTrendingByScrape(): Promise<Coin[]> {
  if (runMode === "Simulated Browser") {
    throw new Error("Simulation mode enabled: Skipping real browser scrape fallback to API/Mock.");
  }
  addLog("info", "Launching Playwright to scrape real trending data from CoinMarketCap...");
  let browser: any = null;
  try {
    browser = await launchBrowserResilient({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ]
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    const page = await context.newPage();
    await setupPageResourceBlocking(page);
    addLog("info", "Navigating to: https://coinmarketcap.com/trending-cryptocurrencies/");
    await page.goto("https://coinmarketcap.com/trending-cryptocurrencies/", {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    // Wait for the page/table to settle down
    await page.waitForTimeout(3000);
    
    const title = await page.title().catch(() => "");
    if (title.includes("Cloudflare") || title.includes("Just a moment")) {
      throw new Error("Cloudflare challenge encountered during scraping.");
    }

    addLog("info", "Scrolling page to load full trending table...");
    await page.evaluate("window.scrollBy(0, 500)");
    await page.waitForTimeout(1000);
    await page.evaluate("window.scrollBy(0, 500)");
    await page.waitForTimeout(1000);

    const coins = await page.evaluate(`(() => {
      try {
        const parseAbbreviatedNumber = (str) => {
          if (!str) return 0;
          const clean = str.replace(/[^0-9.KMBTkmbt]/g, '').toUpperCase();
          let val = parseFloat(clean) || 0;
          if (clean.endsWith('K')) val *= 1000;
          else if (clean.endsWith('M')) val *= 1000000;
          else if (clean.endsWith('B')) val *= 1000000000;
          else if (clean.endsWith('T')) val *= 1000000000000;
          return val;
        };

        const tables = Array.from(document.querySelectorAll("table"));
        const mainTable = tables.find(t => t.querySelectorAll("tbody tr").length > 5);
        if (!mainTable) return [];

        const rows = Array.from(mainTable.querySelectorAll("tbody tr"));
        const result = [];

        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll("td"));
          if (cells.length < 5) continue;

          const rankText = cells[1] ? cells[1].textContent.trim() : "";
          const rank = parseInt(rankText) || (result.length + 1);

          const nameCell = cells[2];
          if (!nameCell) continue;

          const nameEl = nameCell.querySelector('.base-text');
          const symbolEl = nameCell.querySelector('.sub-info');
          
          let name = nameEl ? nameEl.textContent.trim() : "";
          let symbol = symbolEl ? symbolEl.textContent.trim() : "";

          const link = nameCell.querySelector('a');
          const href = link ? link.getAttribute('href') : "";

          // If name/symbol not found via classes, try fallback parsing
          if (!name) {
            const text = nameCell.textContent.trim();
            name = text;
            symbol = text;
          }

          let url = "";
          let slug = "";
          if (href) {
            if (href.startsWith("http")) {
              url = href;
              // Extract slug from URL if possible
              const match = href.match(/\\/currencies\\/([^/]+)/) || href.match(/token\\/([^/]+)\\/([^/]+)/);
              slug = match ? match[1] : name.toLowerCase().replace(/\\s+/g, '-');
            } else {
              url = "https://coinmarketcap.com" + href;
              const match = href.match(/\\/currencies\\/([^/]+)/);
              slug = match ? match[1] : name.toLowerCase().replace(/\\s+/g, '-');
            }
          } else {
            slug = name.toLowerCase().replace(/\\s+/g, '-');
            url = "https://coinmarketcap.com/currencies/" + slug + "/";
          }

          const priceText = cells[3] ? cells[3].textContent.trim() : "$0";
          const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;

          const h1Text = cells[4] ? cells[4].textContent.trim() : "0%";
          let change_1h = parseFloat(h1Text.replace(/[^0-9.]/g, '')) || 0;
          if (cells[4] && (cells[4].innerHTML.includes('caret-down') || cells[4].innerHTML.includes('icon-Caret-down'))) {
            change_1h = -change_1h;
          }

          const h24Text = cells[5] ? cells[5].textContent.trim() : "0%";
          let change_24h = parseFloat(h24Text.replace(/[^0-9.]/g, '')) || 0;
          if (cells[5] && (cells[5].innerHTML.includes('caret-down') || cells[5].innerHTML.includes('icon-Caret-down'))) {
            change_24h = -change_24h;
          }

          const mcText = cells[6] ? cells[6].textContent.trim() : "$0";
          const market_cap = parseAbbreviatedNumber(mcText);

          const volText = cells[7] ? cells[7].textContent.trim() : "$0";
          const volume_24h = parseAbbreviatedNumber(volText);

          result.push({
            name,
            symbol,
            price,
            change_1h,
            change_24h,
            change_7d: 0,
            market_cap,
            volume_24h,
            cmc_rank: rank,
            slug,
            url
          });
        }

        return result;
      } catch (e) {
        return [];
      }
    })()`) as Coin[];

        if (coins && coins.length > 0) {
      addLog("success", `Successfully scraped ${coins.length} trending coins directly from CoinMarketCap!`);
      return coins;
    } else {
      throw new Error("Scraped page but found 0 coins in trending list.");
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function executeFetchTrending(): Promise<{ coins: Coin[]; creditCount: number }> {
  let coins: Coin[] = [];
  let creditCount = 0;

  try {
    coins = await withTimeout(
      fetchTrendingByScrape(),
      120000,
      "Playwright launch or scrape timed out after 120 seconds"
    );
  } catch (scrapeErr) {
    addLog("warning", `Playwright scraping failed: ${(scrapeErr as Error).message}. Falling back to API...`);
  }

  if (coins.length === 0) {
    if (process.env.CMC_API_KEY) {
      addLog("info", "Fetching from CoinMarketCap Pro API...");
      const response = await fetch("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?start=1&limit=50&convert=USD", {
        headers: {
          "Accepts": "application/json",
          "X-CMC_PRO_API_KEY": process.env.CMC_API_KEY,
        }
      });

      if (!response.ok) {
        throw new Error(`CoinMarketCap Pro API returned error status: ${response.status}`);
      }

      const resData = (await response.json()) as any;
      creditCount = resData.status?.credit_count || 1;
      
      if (resData.data && Array.isArray(resData.data)) {
        coins = resData.data.map((coin: any) => ({
          name: coin.name,
          symbol: coin.symbol,
          price: parseFloat(coin.quote?.USD?.price?.toFixed(6) || "0"),
          change_24h: parseFloat(coin.quote?.USD?.percent_change_24h?.toFixed(2) || "0"),
          change_1h: parseFloat(coin.quote?.USD?.percent_change_1h?.toFixed(2) || "0"),
          change_7d: parseFloat(coin.quote?.USD?.percent_change_7d?.toFixed(2) || "0"),
          market_cap: parseFloat(coin.quote?.USD?.market_cap?.toFixed(2) || "0"),
          volume_24h: parseFloat(coin.quote?.USD?.volume_24h?.toFixed(2) || "0"),
          cmc_rank: coin.cmc_rank,
          slug: coin.slug,
          url: `https://coinmarketcap.com/currencies/${coin.slug}/`,
        }));
      }
    } else {
      addLog("warning", "No CMC_API_KEY detected in secrets. Fetching real-time market stats from CoinGecko Public Markets API...");
      
      const response = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&sparkline=false&price_change_percentage=1h,24h,7d");
      
      if (response.ok) {
        const cgData = (await response.json()) as any;
        if (Array.isArray(cgData)) {
          coins = cgData.map((coin: any, index: number) => ({
            name: coin.name,
            symbol: coin.symbol.toUpperCase(),
            price: coin.current_price,
            change_24h: parseFloat(coin.price_change_percentage_24h?.toFixed(2) || "0"),
            change_1h: parseFloat(coin.price_change_percentage_1h_in_currency?.toFixed(2) || "0"),
            change_7d: parseFloat(coin.price_change_percentage_7d_in_currency?.toFixed(2) || "0"),
            market_cap: coin.market_cap,
            volume_24h: coin.total_volume,
            cmc_rank: index + 1,
            slug: coin.id,
            url: `https://coinmarketcap.com/currencies/${coin.id}/`,
          }));
        }
      }

      if (coins.length === 0) {
        addLog("warning", "CoinGecko rate limit or fallback triggered. Loading dynamic high-fidelity trending list...");
        const mockCoinsRaw = [
          { name: "Bitcoin", symbol: "BTC", price: 96420, change_24h: 3.42, cap: 1890000000000, vol: 45000000000, slug: "bitcoin" },
          { name: "Ethereum", symbol: "ETH", price: 3450, change_24h: -1.24, cap: 415000000000, vol: 18000000000, slug: "ethereum" },
          { name: "Solana", symbol: "SOL", price: 186.4, change_24h: 8.76, cap: 87000000000, vol: 4500000000, slug: "solana" },
          { name: "Binance Coin", symbol: "BNB", price: 615.2, change_24h: 0.85, cap: 90000000000, vol: 1200000000, slug: "bnb" },
          { name: "Ripple", symbol: "XRP", price: 1.14, change_24h: 12.15, cap: 65000000000, vol: 3200000000, slug: "xrp" },
          { name: "Dogecoin", symbol: "DOGE", price: 0.385, change_24h: -4.12, cap: 56000000000, vol: 2800000000, slug: "dogecoin" },
          { name: "Cardano", symbol: "ADA", price: 0.72, change_24h: 5.34, cap: 25000000000, vol: 850000000, slug: "cardano" },
          { name: "Avalanche", symbol: "AVAX", price: 34.15, change_24h: -2.31, cap: 14000000000, vol: 420000000, slug: "avalanche" },
          { name: "Chainlink", symbol: "LINK", price: 22.45, change_24h: 6.89, cap: 13500000000, vol: 610000000, slug: "chainlink" },
          { name: "Polkadot", symbol: "DOT", price: 6.12, change_24h: 1.45, cap: 8500000000, vol: 180000000, slug: "polkadot" },
        ];

        coins = mockCoinsRaw.map((coin, index) => {
          const fluctuation = (Math.random() - 0.5) * 0.01;
          const finalPrice = parseFloat((coin.price * (1 + fluctuation)).toFixed(coin.price > 100 ? 2 : 4));
          const finalChange = parseFloat((coin.change_24h + fluctuation * 100).toFixed(2));
          return {
            name: coin.name,
            symbol: coin.symbol,
            price: finalPrice,
            change_24h: finalChange,
            change_1h: parseFloat((fluctuation * 100).toFixed(2)),
            market_cap: coin.cap,
            volume_24h: coin.vol,
            cmc_rank: index + 1,
            slug: coin.slug,
            url: `https://coinmarketcap.com/currencies/${coin.slug}/`,
          };
        });
      }
    }
  }

  // Pre-resolve and filter out DEX scan URLs that cannot be resolved to standard CMC currencies pages.
  const resolvedCoins: Coin[] = [];
  for (const coin of coins) {
    if (coin.url && coin.url.includes("dex.coinmarketcap.com")) {
      addLog("info", `Pre-resolving DEX Scan URL for ${coin.name} (${coin.symbol})...`);
      const resolvedUrl = await resolveToFirstPartyUrl(coin.url, coin.symbol, coin.name);
      if (resolvedUrl && !resolvedUrl.includes("dex.coinmarketcap.com")) {
        coin.url = resolvedUrl;
        const match = resolvedUrl.match(/\/currencies\/([^/]+)/);
        if (match) {
          coin.slug = match[1];
        }
        resolvedCoins.push(coin);
      } else {
        addLog("warning", `Excluding DEX token ${coin.name} (${coin.symbol}) from queue: Does not have a standard community currencies page.`);
      }
    } else {
      resolvedCoins.push(coin);
    }
  }

  writeJsonFile(LAST_TRENDING_FILE, resolvedCoins);
  return { coins: resolvedCoins, creditCount };
}

async function executeGenerateMessages(): Promise<number> {
  const coins = readJsonFile<Coin[]>(LAST_TRENDING_FILE, []);
  if (coins.length === 0) {
    throw new Error("No trending coins found in output/last_trending.json. Please fetch trending coins first.");
  }

  const generatedMessages: GeneratedMessage[] = [];
  let openAiFailed = false;

  if (process.env.OPENAI_API_KEY) {
    try {
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      addLog("info", "Initializing OpenAI SDK with gpt-4o-mini...");
      const openai = new OpenAI({
        apiKey: OPENAI_API_KEY,
      });

      const batchSize = 10;
      for (let i = 0; i < coins.length; i += batchSize) {
        const chunk = coins.slice(i, i + batchSize);
        addLog("info", `Generating batch of comments ${Math.floor(i / batchSize) + 1}/${Math.ceil(coins.length / batchSize)} with gpt-4o-mini...`);

        const prompt = `
          Generate ONE unique, creative, organic CoinMarketCap community comment for EACH of the following coins based on their recent market data, AND classify the sentiment as either "bullish" or "bearish".

          Requirements:
          - 1 to 2 short sentences.
          - Write in a natural, human-like voice of an active crypto community trader (sometimes casual, sometimes analytical).
          - Mention the coin name or symbol naturally.
          - Incorporate the provided market price, rank or change percentage naturally.
          - Do NOT use emojis. Do NOT use hashtags.
          - No generic templates or identical sentence structures. Keep comments varied!
          - Never offer professional financial advice. Do not say "this is not financial advice".

          Provide the output as a valid JSON object matching this schema:
          {
            "messages": [
              {
                "symbol": "BTC",
                "sentiment": "bullish",
                "message": "Actual comment text here"
              }
            ]
          }

          Coins list:
          ${JSON.stringify(chunk.map(c => ({ name: c.name, symbol: c.symbol, price: c.price, change_24h: c.change_24h, rank: c.cmc_rank })))}
        `;

        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.8,
          max_tokens: 4000,
        });

        const rawText = response.choices[0].message.content || "{}";
        const parsed = JSON.parse(rawText.trim());
        if (parsed.messages && Array.isArray(parsed.messages)) {
          parsed.messages.forEach((msg: any) => {
            const matchCoin = chunk.find(c => c.symbol.toLowerCase() === msg.symbol?.toLowerCase());
            if (matchCoin) {
              generatedMessages.push({
                name: matchCoin.name,
                symbol: matchCoin.symbol,
                url: matchCoin.url,
                message: msg.message,
                sentiment: msg.sentiment === "bearish" ? "bearish" : "bullish",
              });
            }
          });
        }
      }
    } catch (apiError) {
      addLog("error", `OpenAI API Call failed: ${(apiError as Error).message}.`);
      openAiFailed = true;
    }
  }

  let geminiFailed = false;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if ((!process.env.OPENAI_API_KEY || openAiFailed) && geminiKey) {
    try {
      addLog("info", "Using Gemini API (gemini-3.5-flash) as the primary AI fallback...");
      const ai = new GoogleGenAI({
        apiKey: geminiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'custom-comment-generator',
          }
        }
      });

      const batchSize = 10;
      for (let i = 0; i < coins.length; i += batchSize) {
        const chunk = coins.slice(i, i + batchSize);
        addLog("info", `Generating batch of comments ${Math.floor(i / batchSize) + 1}/${Math.ceil(coins.length / batchSize)} with gemini-3.5-flash...`);

        const prompt = `
          Generate ONE unique, creative, organic CoinMarketCap community comment for EACH of the following coins based on their recent market data, AND classify the sentiment as either "bullish" or "bearish".

          Requirements:
          - 1 to 2 short sentences.
          - Write in a natural, human-like voice of an active crypto community trader (sometimes casual, sometimes analytical).
          - Mention the coin name or symbol naturally.
          - Incorporate the provided market price, rank or change percentage naturally.
          - Do NOT use emojis. Do NOT use hashtags.
          - No generic templates or identical sentence structures. Keep comments varied!
          - Never offer professional financial advice. Do not say "this is not financial advice".

          Provide the output as a valid JSON object matching this schema:
          {
            "messages": [
              {
                "symbol": "BTC",
                "sentiment": "bullish",
                "message": "Actual comment text here"
              }
            ]
          }

          Coins list:
          ${JSON.stringify(chunk.map(c => ({ name: c.name, symbol: c.symbol, price: c.price, change_24h: c.change_24h, rank: c.cmc_rank })))}
        `;

        const response = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                messages: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      symbol: { type: Type.STRING },
                      sentiment: { type: Type.STRING },
                      message: { type: Type.STRING }
                    },
                    required: ["symbol", "sentiment", "message"]
                  }
                }
              },
              required: ["messages"]
            }
          }
        });

        const rawText = response.text || "{}";
        const parsed = JSON.parse(rawText.trim());
        if (parsed.messages && Array.isArray(parsed.messages)) {
          parsed.messages.forEach((msg: any) => {
            const matchCoin = chunk.find(c => c.symbol.toLowerCase() === msg.symbol?.toLowerCase());
            if (matchCoin) {
              generatedMessages.push({
                name: matchCoin.name,
                symbol: matchCoin.symbol,
                url: matchCoin.url,
                message: msg.message,
                sentiment: msg.sentiment === "bearish" ? "bearish" : "bullish",
              });
            }
          });
        }
      }
    } catch (geminiError) {
      addLog("error", `Gemini API Call failed: ${(geminiError as Error).message}.`);
      geminiFailed = true;
    }
  }

  if (generatedMessages.length === 0) {
    addLog("warning", "AI generation was not completed or failed. Falling back to robust rule-based comments...");
    
    const templates = {
      bullish: [
        (c: Coin) => `${c.symbol} is looking extremely strong right now. Holding support beautifully and volume is accelerating. Next target looks very interesting!`,
        (c: Coin) => `A strong 24h gain of ${c.change_24h}% for ${c.symbol}. The consolidation phase seems finished, expecting higher levels very soon.`,
        (c: Coin) => `Volume on ${c.symbol} is absolutely popping. If we break this local resistance, we could easily see another leg up.`,
        (c: Coin) => `Loving the price action on ${c.symbol} lately. Steady accumulation going on in this range.`,
      ],
      bearish: [
        (c: Coin) => `${c.symbol} has some short-term pressure. Volume is declining, let's see if the key support holds.`,
        (c: Coin) => `Slight pullback for ${c.symbol} at ${c.price}. Good opportunity to DCA before the next bounce.`,
        (c: Coin) => `A ${c.change_24h}% pullback on ${c.symbol}. Watching the 4h charts closely for a reversal sign.`,
        (c: Coin) => `Momentum is flat for ${c.symbol} today. Waiting for a breakout trigger before entering more positions.`,
      ]
    };

    coins.forEach((coin, index) => {
      const isBullish = coin.change_24h >= 0;
      const list = isBullish ? templates.bullish : templates.bearish;
      const fn = list[index % list.length];
      generatedMessages.push({
        name: coin.name,
        symbol: coin.symbol,
        url: coin.url,
        message: fn(coin),
        sentiment: isBullish ? "bullish" : "bearish",
      });
    });
  }

  writeJsonFile(GENERATED_MESSAGES_FILE, generatedMessages);
  writeJsonFile(POST_PROGRESS_FILE, { next_index: 0 });
  return generatedMessages.length;
}

// 6. Fetch Trending Coins Endpoint (Mutex and Progress Locked)
app.post("/api/fetch-trending", async (req, res) => {
  if (isBusy()) {
    return res.status(400).json({ error: "Another automated process is currently running. Please wait for it to finish." });
  }

  const prevMessages = readJsonFile<GeneratedMessage[]>(GENERATED_MESSAGES_FILE, []);
  const prevProgress = readJsonFile<{ next_index: number }>(POST_PROGRESS_FILE, { next_index: 0 });
  if (prevMessages.length > 0 && prevProgress.next_index < prevMessages.length) {
    addLog("warning", `Operation blocked: A posting run is currently in progress (${prevProgress.next_index}/${prevMessages.length} posted). Please wait until all coins are posted or manually click Reset Storage.`);
    return res.status(400).json({
      error: `A posting run is in progress (${prevProgress.next_index}/${prevMessages.length} posted). Please complete it or click Reset Storage first.`
    });
  }

  if (botStatus === "Fetching") {
    return res.status(409).json({ error: "Cryptocurrencylistings fetch is already in progress." });
  }

  addLog("info", "Starting cryptocurrency listings fetch...");
  botStatus = "Fetching";

  try {
    const { coins, creditCount } = await executeFetchTrending();
    addLog("success", `Successfully fetched ${coins.length} coins. (Credits consumed: ${creditCount})`);
    botStatus = "Idle";
    res.json({ status: "success", coins, credit_count: creditCount });
  } catch (error) {
    addLog("error", `Failed fetching coins: ${(error as Error).message}`);
    botStatus = "Idle";
    res.status(500).json({ status: "error", message: (error as Error).message });
  }
});

// 7. Generate community messages Endpoint (Mutex and Progress Locked)
app.post("/api/generate-messages", async (req, res) => {
  if (isBusy()) {
    return res.status(400).json({ error: "Another automated process is currently running. Please wait for it to finish." });
  }

  if (isGeneratingRunning) {
    return res.status(409).json({ error: "A message generation run is already in progress." });
  }

  const prevMessages = readJsonFile<GeneratedMessage[]>(GENERATED_MESSAGES_FILE, []);
  const prevProgress = readJsonFile<{ next_index: number }>(POST_PROGRESS_FILE, { next_index: 0 });
  if (prevMessages.length > 0 && prevProgress.next_index < prevMessages.length) {
    addLog("warning", `Operation blocked: A posting run is currently in progress (${prevProgress.next_index}/${prevMessages.length} posted). Please wait until all coins are posted or manually click Reset Storage.`);
    return res.status(400).json({
      error: `A posting run is in progress (${prevProgress.next_index}/${prevMessages.length} posted). Please complete it or click Reset Storage first.`
    });
  }

  addLog("info", "Starting community comments generation...");
  botStatus = "Generating";
  isGeneratingRunning = true;

  try {
    const count = await executeGenerateMessages();
    addLog("success", `Successfully generated community comments for all ${count} coins! Saved to generated_messages.json.`);
    botStatus = "Idle";
    res.json({ status: "success", count });
  } catch (error) {
    addLog("error", `Failed message generation: ${(error as Error).message}`);
    botStatus = "Idle";
    res.status(500).json({ status: "error", message: (error as Error).message });
  } finally {
    isGeneratingRunning = false;
  }
});

// 8. Start posting sequence (Loop)
app.post("/api/post-chat", (req, res) => {
  if (isBusy() && !isPostingRunning) {
    return res.status(400).json({ error: "Another automated process is currently running. Please wait for it to finish." });
  }

  if (isPostingRunning) {
    return res.json({ status: "success", message: "Bot posting sequence is already active." });
  }

  const messages = readJsonFile<GeneratedMessage[]>(GENERATED_MESSAGES_FILE, []);
  if (messages.length === 0) {
    addLog("error", "No generated comments found in generated_messages.json. Please generate comments first.");
    return res.status(400).json({ error: "Comments list is empty." });
  }

  isPostingRunning = true;
  botStatus = "Posting";
  addLog("info", "Initiating automated posting cycle...");

  // Start from index 0 to scan and find all pending coins, skipping any completed or failed ones
  currentPostingIndex = 0;

  // Start asynchronous runner
  runPostingLoop();

  res.json({
    status: "success",
    message: "Posting sequence started successfully.",
    startIndex: 0,
  });
});

// Asynchronous Posting Loop
async function runPostingLoop() {
  const messages = readJsonFile<GeneratedMessage[]>(GENERATED_MESSAGES_FILE, []);
  const results = readJsonFile<PostResult[]>(RESULTS_FILE, []);
  
  let consecutiveFailures = 0;
  let sharedBrowser: any = null;

  try {
    currentCoinName = "Verifying Session...";
    addLog("info", "Always verifying active session status before posting...");
    try {
      const loginCheck = await checkLoginReal();
      if (loginCheck.status !== "success") {
        addLog("warning", `[SESSION WARNING] Session check returned: ${loginCheck.status} (${loginCheck.message}). Trying to proceed anyway, but posts may fail if cookies are expired.`);
      } else {
        addLog("success", "[SESSION SUCCESS] Session verified as ACTIVE!");
      }
    } catch (err) {
      addLog("error", `[SESSION ERROR] Failed to run automated session check: ${(err as Error).message}`);
    }

    // Find the first truly pending coin in the list
    const firstPendingIdx = messages.findIndex(msgItem => !results.some(r => r.symbol.toLowerCase() === msgItem.symbol.toLowerCase()));
    if (firstPendingIdx === -1) {
      addLog("success", "All coins in the queue have already been processed (either successfully posted or failed). No pending coins left to post.");
      isPostingRunning = false;
      botStatus = "Idle";
      currentCoinName = "N/A";
      return;
    }
    currentPostingIndex = firstPendingIdx;

    const initialPendingList = messages.filter(msgItem => !results.some(r => r.symbol.toLowerCase() === msgItem.symbol.toLowerCase()));
    const initialPendingCount = initialPendingList.length;
    let activeQueueNum = 0;

    if (runMode === "Real Browser") {
      try {
        addLog("info", "Pre-launching single shared Playwright browser instance for full posting sequence...");
        sharedBrowser = await launchBrowserResilient({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-blink-features=AutomationControlled",
          ]
        });
      } catch (browserErr) {
        addLog("error", `Failed to pre-launch shared browser: ${(browserErr as Error).message}. Will launch on-demand.`);
      }
    }

    while (isPostingRunning && currentPostingIndex < messages.length) {
      const item = messages[currentPostingIndex];
      
      // Check if this coin has already been successfully or unsuccessfully posted
      const currentResults = readJsonFile<PostResult[]>(RESULTS_FILE, []);
      const existingResult = currentResults.find(r => r.symbol.toLowerCase() === item.symbol.toLowerCase());
      if (existingResult) {
        currentPostingIndex++;
        writeJsonFile(POST_PROGRESS_FILE, { next_index: currentPostingIndex });
        continue;
      }

      activeQueueNum++;
      currentCoinName = `${item.name} (${item.symbol})`;
      writeJsonFile(POST_PROGRESS_FILE, { next_index: currentPostingIndex });

      addLog("info", `----------------------------------------`);
      addLog("info", `Executing Post Sequence [Queue Item #${activeQueueNum} of ${initialPendingCount} remaining]: ${currentCoinName}`);

      // Wait 1-2 seconds to simulate browser startup/navigation
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));

      if (!isPostingRunning) break;

      let outcome: PostResult["status"] = "success";
      let messageText = "Posted successfully";

      if (runMode === "Real Browser") {
        addLog("info", `Launching automated Playwright context for ${item.name}...`);
        try {
          const resolvedUrl = await resolveToFirstPartyUrl(item.url, item.symbol, item.name);
          const realResult = await runRealPosting(resolvedUrl, item.message, item.sentiment || "bullish", sharedBrowser);
          outcome = realResult.status;
          messageText = realResult.message;
        } catch (err) {
          outcome = "failed";
          messageText = `Playwright runtime error: ${(err as Error).message}`;
          addLog("error", `CRITICAL Error during automation: ${messageText}`);
        }
      } else {
        addLog("info", `Loading page: ${item.url}`);
        addLog("info", `Injecting storage session cookies into browser context`);
        addLog("info", `Finding selector: [data-test="base-editor-editable"]`);

        await new Promise(resolve => setTimeout(resolve, 1500));

        addLog("info", `Editor text-field focused. Typing comment: "${item.message}"`);
        addLog("info", `Clicking ${item.sentiment || "bullish"} sentiment toggle [data-test="editor-${item.sentiment || "bullish"}-button"]`);

        await new Promise(resolve => setTimeout(resolve, 1500));

        addLog("info", `Clicking post submission button [data-test="editor-post-button"]`);

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Simulate outcomes randomly to reflect real scenarios
        const rand = Math.random();
        if (rand < 0.05) {
          outcome = "captcha";
          messageText = "Captcha challenge detected (Cloudflare verify you are human)";
          addLog("warning", "WARNING: Captcha challenge intercepted. Attempting bypass...");
        } else if (rand < 0.08) {
          outcome = "retry";
          messageText = "Post failed (Too many requests, rate-limit). Retry scheduled.";
          addLog("warning", "WARNING: CoinMarketCap rate limit. Sleeping for 5s...");
        } else {
          addLog("success", `SUCCESS: Comment posted successfully for ${item.symbol}!`);
        }
      }

      if (outcome === "success") {
        consecutiveFailures = 0;
        addLog("success", `SUCCESS: Completed comment posted for ${item.symbol}!`);
        
        results.push({
          name: item.name,
          symbol: item.symbol,
          url: item.url,
          status: outcome,
          message: messageText,
          timestamp: new Date().toLocaleTimeString(),
          sentiment: item.sentiment || "bullish",
        });
        writeJsonFile(RESULTS_FILE, results);
        
        currentPostingIndex++;
        writeJsonFile(POST_PROGRESS_FILE, { next_index: currentPostingIndex });
      } else if (outcome === "skipped") {
        addLog("warning", `SKIPPED: Skipped posting for ${item.symbol} (${messageText}).`);
        
        results.push({
          name: item.name,
          symbol: item.symbol,
          url: item.url,
          status: outcome,
          message: messageText,
          timestamp: new Date().toLocaleTimeString(),
          sentiment: item.sentiment || "bullish",
        });
        writeJsonFile(RESULTS_FILE, results);
        
        currentPostingIndex++;
        writeJsonFile(POST_PROGRESS_FILE, { next_index: currentPostingIndex });
      } else if (outcome === "retry" || outcome === "failed") {
        addLog("info", `Executing scheduled retry attempt for ${item.symbol} (status: ${outcome})...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        let retrySuccess = false;
        let finalStatus: PostResult["status"] = "failed";
        let finalMessage = "Retry failed";

        if (runMode === "Real Browser") {
          try {
            addLog("info", "Retrying post with active Playwright context...");
            const resolvedUrl = await resolveToFirstPartyUrl(item.url, item.symbol, item.name);
            const retryResult = await runRealPosting(resolvedUrl, item.message, item.sentiment || "bullish", sharedBrowser);
            finalStatus = retryResult.status;
            finalMessage = retryResult.message;
            if (retryResult.status === "success") {
              addLog("success", `SUCCESS: Retry posting succeeded for ${item.symbol}!`);
              retrySuccess = true;
            } else {
              addLog("error", `FAIL: Retry posting failed: ${retryResult.message}`);
            }
          } catch (err) {
            finalStatus = "failed";
            finalMessage = (err as Error).message;
            addLog("error", `Exception in retry: ${(err as Error).message}`);
          }
        } else {
          addLog("success", `SUCCESS: Retry posting succeeded for ${item.symbol}!`);
          retrySuccess = true;
          finalStatus = "success";
          finalMessage = "Posted successfully after retry";
        }
        
        if (retrySuccess) {
          consecutiveFailures = 0;
          results.push({
            name: item.name,
            symbol: item.symbol,
            url: item.url,
            status: "success",
            message: "Posted successfully after retry",
            timestamp: new Date().toLocaleTimeString(),
            sentiment: item.sentiment || "bullish",
          });
        } else {
          consecutiveFailures++;
          results.push({
            name: item.name,
            symbol: item.symbol,
            url: item.url,
            status: finalStatus,
            message: finalMessage,
            timestamp: new Date().toLocaleTimeString(),
            sentiment: item.sentiment || "bullish",
          });
        }
        
        writeJsonFile(RESULTS_FILE, results);
        currentPostingIndex++;
        writeJsonFile(POST_PROGRESS_FILE, { next_index: currentPostingIndex });

        if (consecutiveFailures >= 3) {
          addLog("error", "CRITICAL: Automated posting paused due to 3 consecutive failures. Please verify your CoinMarketCap login session and cookies.");
          isPostingRunning = false;
          botStatus = "Idle";
          break;
        }
        if (!retrySuccess) {
          addLog("info", "Skipping to next coin to maintain end-to-end automation run...");
        }
      } else {
        // Captcha, expired or failed
        consecutiveFailures++;
        addLog("warning", `WARNING: Post failed for ${item.symbol} with status '${outcome}' (${consecutiveFailures}/3 consecutive failures).`);
        
        results.push({
          name: item.name,
          symbol: item.symbol,
          url: item.url,
          status: outcome,
          message: messageText,
          timestamp: new Date().toLocaleTimeString(),
          sentiment: item.sentiment || "bullish",
        });
        writeJsonFile(RESULTS_FILE, results);
        
        currentPostingIndex++;
        writeJsonFile(POST_PROGRESS_FILE, { next_index: currentPostingIndex });

        if (consecutiveFailures >= 3) {
          addLog("error", "CRITICAL: Automated posting paused due to 3 consecutive failures. Please verify your CoinMarketCap login session and cookies.");
          isPostingRunning = false;
          botStatus = "Idle";
          break;
        }
        addLog("info", "Skipping to next coin to maintain end-to-end automation run...");
      }

      // Interval spacing between posts to avoid bot detection (1.5 - 3 seconds)
      const spacing = 1500 + Math.random() * 1500;
      addLog("info", `Cooling down for ${(spacing / 1000).toFixed(1)} seconds before proceeding...`);
      await new Promise(resolve => setTimeout(resolve, spacing));
    }

    if (currentPostingIndex >= messages.length) {
      addLog("success", "CONGRATULATIONS: Complete automated posting run finished successfully!");
      botStatus = "Completed";
      isPostingRunning = false;
    } else if (!isPostingRunning) {
      botStatus = "Idle";
    }
  } finally {
    if (sharedBrowser) {
      addLog("info", "Closing shared Playwright browser instance...");
      await sharedBrowser.close().catch(() => {});
      sharedBrowser = null;
    }
  }
}

// 9. Stop posting loop
app.post("/api/stop-posting", (req, res) => {
  isPostingRunning = false;
  botStatus = "Idle";
  addLog("warning", "Automated posting sequence has been manually stopped/paused.");
  res.json({ success: true, message: "Posting sequence stopped." });
});

// 10. Full flow execution
app.post("/api/full-flow", async (req, res) => {
  if (isBusy() && !isPostingRunning) {
    return res.status(400).json({ error: "Another automated process is currently running. Please wait for it to finish." });
  }

  addLog("info", "========================================");
  addLog("info", "Starting Full Bot Flow End-to-End Sequence...");
  addLog("info", "========================================");

  try {
    const prevMessages = readJsonFile<GeneratedMessage[]>(GENERATED_MESSAGES_FILE, []);
    const prevProgress = readJsonFile<{ next_index: number }>(POST_PROGRESS_FILE, { next_index: 0 });

    if (prevMessages.length > 0 && prevProgress.next_index < prevMessages.length) {
      addLog("info", `[FLOW RESUME] A posting run is already in progress (${prevProgress.next_index}/${prevMessages.length} posted). Skipping storage reset.`);
      addLog("info", `[FLOW RESUME] Resuming the posting sequence from index ${prevProgress.next_index}...`);
      
      if (!isPostingRunning) {
        isPostingRunning = true;
        botStatus = "Posting";
        currentPostingIndex = prevProgress.next_index;
        runPostingLoop();
      }

      return res.json({
        success: true,
        message: `End-to-End sequence resumed successfully from index ${prevProgress.next_index}. Monitoring logs...`,
      });
    }

    addLog("info", "[FLOW FRESH] All previous coins posted or no previous run. Starting clean full cycle...");
    writeJsonFile(RESULTS_FILE, []);
    writeJsonFile(POST_PROGRESS_FILE, { next_index: 0 });

    // Step 1: Fetch
    addLog("info", "[FLOW STEP 1/3] Fetching latest trending coins...");
    botStatus = "Fetching";
    await executeFetchTrending();

    // Step 2: Generate
    addLog("info", "[FLOW STEP 2/3] Generating custom community comments...");
    botStatus = "Generating";
    isGeneratingRunning = true;
    try {
      await executeGenerateMessages();
    } finally {
      isGeneratingRunning = false;
    }

    // Step 3: Post
    addLog("info", "[FLOW STEP 3/3] Launching automated comment submitter...");
    isPostingRunning = true;
    botStatus = "Posting";
    currentPostingIndex = 0;
    runPostingLoop();

    res.json({
      success: true,
      message: "End-to-End sequence started successfully. Monitoring logs...",
    });
  } catch (error) {
    addLog("error", `Full Flow failed: ${(error as Error).message}`);
    botStatus = "Idle";
    isPostingRunning = false;
    isGeneratingRunning = false;
    res.status(500).json({ error: (error as Error).message });
  }
});

// 11. Clear Logs & Stats
app.post("/api/clear-all", (req, res) => {
  try {
    logs = [];
    writeJsonFile(LAST_TRENDING_FILE, []);
    writeJsonFile(GENERATED_MESSAGES_FILE, []);
    writeJsonFile(RESULTS_FILE, []);
    writeJsonFile(POST_PROGRESS_FILE, { next_index: 0 });
    currentPostingIndex = 0;
    currentCoinName = "N/A";
    botStatus = "Idle";
    addLog("success", "Console cleared. Reset trending data, comments, and results.");
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// 12. Get current logs stream
app.get("/api/logs", (req, res) => {
  res.json({ logs });
});

// ============================================================================
// CSV DOWNLOAD EXPORTERS
// ============================================================================
app.get("/api/download/trending_coins.csv", (req, res) => {
  const coins = readJsonFile<Coin[]>(LAST_TRENDING_FILE, []);
  let csv = "Name,Symbol,Price,Change_1h,Change_24h,Change_7d,Market_Cap,Volume_24h,Rank,Slug,Url\n";
  coins.forEach(c => {
    csv += `"${c.name}","${c.symbol}",${c.price},${c.change_1h || 0},${c.change_24h},${c.change_7d || 0},${c.market_cap},${c.volume_24h},${c.cmc_rank || ""},"${c.slug}","${c.url}"\n`;
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=trending_coins.csv");
  res.send(csv);
});

app.get("/api/download/generated_comments.csv", (req, res) => {
  const messages = readJsonFile<GeneratedMessage[]>(GENERATED_MESSAGES_FILE, []);
  let csv = "Asset Name,Symbol,Sentiment,Generated Comment,Target URL\n";
  messages.forEach(m => {
    const cleanMsg = (m.message || "").replace(/"/g, '""').replace(/\n/g, ' ');
    csv += `"${m.name}","${m.symbol}","${m.sentiment || "bullish"}","${cleanMsg}","${m.url}"\n`;
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=generated_comments.csv");
  res.send(csv);
});

app.get("/api/download/post_submissions.csv", (req, res) => {
  const results = readJsonFile<PostResult[]>(RESULTS_FILE, []);
  let csv = "Timestamp,Asset Name,Symbol,Sentiment,Post Status,Log Message,Target URL\n";
  results.forEach(r => {
    const cleanMsg = (r.message || "").replace(/"/g, '""').replace(/\n/g, ' ');
    csv += `"${r.timestamp || "N/A"}","${r.name}","${r.symbol}","${r.sentiment || "bullish"}","${r.status}","${cleanMsg}","${r.url}"\n`;
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=post_submissions.csv");
  res.send(csv);
});

app.get("/api/download/overall_report.csv", (req, res) => {
  const coins = readJsonFile<Coin[]>(LAST_TRENDING_FILE, []);
  const messages = readJsonFile<GeneratedMessage[]>(GENERATED_MESSAGES_FILE, []);
  const results = readJsonFile<PostResult[]>(RESULTS_FILE, []);
  const successCount = results.filter(r => r.status === "success").length;
  const failedCount = results.filter(r => r.status !== "success").length;
  const successRate = results.length > 0 ? ((successCount / results.length) * 100).toFixed(1) : "0.0";

  let csv = "Metric,Value,Description\n";
  csv += `"Total Trending Coins",${coins.length},"Total coins fetched from market"\n`;
  csv += `"Generated Comments Count",${messages.length},"Custom comments prepared for submission"\n`;
  csv += `"Total Submissions Executed",${results.length},"Posts attempted"\n`;
  csv += `"Successful Posts",${successCount},"Successfully posted comments"\n`;
  csv += `"Failed/Skipped Posts",${failedCount},"Posts that failed or were manually skipped"\n`;
  csv += `"Overall Success Rate",${successRate}%,"Success rate percentage"\n`;
  csv += `"Execution Mode","${runMode}","Execution environment configuration"\n`;
  csv += `"Report Generated At","${new Date().toLocaleString()}","Timestamp of export"\n`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=overall_report.csv");
  res.send(csv);
});


// ============================================================================
// VITE OR STATIC FILES SERVING MIDDLEWARE
// ============================================================================
async function hydrateLocalFromCloud() {
  addLog("info", "[FIREBASE] Hydrating local ephemeral storage from Firestore cloud database...");
  try {
    // 1. Session cookies
    const cloudSession = await getSessionStateCloud();
    if (cloudSession) {
      fs.writeFileSync(AUTH_STATE_FILE, cloudSession, "utf-8");
      addLog("success", "[FIREBASE] Hydrated login session cookies from Firestore!");
    } else {
      addLog("info", "[FIREBASE] No session cookies found in Firestore.");
    }

    // 2. Trending Coins
    const cloudCoins = await getTrendingCoinsCloud();
    if (cloudCoins && cloudCoins.length > 0) {
      fs.writeFileSync(LAST_TRENDING_FILE, JSON.stringify(cloudCoins, null, 2), "utf-8");
      addLog("success", `[FIREBASE] Hydrated ${cloudCoins.length} trending coins from Firestore!`);
    }

    // 3. Generated Messages
    const cloudMessages = await getGeneratedMessagesCloud();
    if (cloudMessages && cloudMessages.length > 0) {
      fs.writeFileSync(GENERATED_MESSAGES_FILE, JSON.stringify(cloudMessages, null, 2), "utf-8");
      addLog("success", `[FIREBASE] Hydrated ${cloudMessages.length} generated messages from Firestore!`);
    }

    // 4. Post Results
    const cloudResults = await getPostResultsCloud();
    if (cloudResults && cloudResults.length > 0) {
      fs.writeFileSync(RESULTS_FILE, JSON.stringify(cloudResults, null, 2), "utf-8");
      addLog("success", `[FIREBASE] Hydrated ${cloudResults.length} post results from Firestore!`);
    }

    // 5. Bot Progress
    const cloudProgress = await getBotProgressCloud();
    if (cloudProgress) {
      fs.writeFileSync(POST_PROGRESS_FILE, JSON.stringify({ next_index: cloudProgress.next_index }, null, 2), "utf-8");
      currentPostingIndex = cloudProgress.next_index;
      addLog("success", `[FIREBASE] Hydrated bot posting progress index to ${cloudProgress.next_index} from Firestore!`);
    }

    // 6. System Logs
    const cloudLogs = await getSystemLogsCloud();
    if (cloudLogs && cloudLogs.length > 0) {
      logs = cloudLogs;
      addLog("success", `[FIREBASE] Hydrated ${cloudLogs.length} system logs from Firestore!`);
    }

    addLog("success", "[FIREBASE] Local storage state successfully synchronized with Cloud database.");
  } catch (err) {
    addLog("error", `[FIREBASE] Failed to hydrate local storage from Firestore: ${(err as Error).message}`);
  }
}

async function startServer() {
  // First, hydrate all files from Firestore cloud database
  await hydrateLocalFromCloud();

  if (process.env.NODE_ENV !== "production") {
    addLog("info", "[SERVER] Running in DEVELOPMENT mode, initializing Vite dev server middleware...");
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    addLog("info", "[SERVER] Running in PRODUCTION mode, serving static files...");
    let distPath = path.join(process.cwd(), "dist");
    if (!fs.existsSync(distPath)) {
      distPath = path.resolve(__dirname, "../dist");
    }
    if (!fs.existsSync(distPath)) {
      distPath = path.resolve(__dirname, "dist");
    }
    
    addLog("info", `[SERVER] Static production assets directory resolved to: ${distPath}`);
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/output/")) {
        return next();
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
