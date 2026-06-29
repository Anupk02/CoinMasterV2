import os
import sys
import json
import asyncio
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime
import csv
import io

from fastapi import FastAPI, HTTPException, Body, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Configure Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("cmc_bot")

app = FastAPI(title="CoinMarketCap Bot Python Backend")

# Enable CORS for frontend compatibility
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Directories & Files
OUTPUT_DIR = "output"
AUTH_DIR = "auth"
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(AUTH_DIR, exist_ok=True)

AUTH_STATE_FILE = os.path.join(AUTH_DIR, "state.json")
LAST_TRENDING_FILE = os.path.join(OUTPUT_DIR, "last_trending.json")
GENERATED_MESSAGES_FILE = os.path.join(OUTPUT_DIR, "generated_messages.json")
RESULTS_FILE = os.path.join(OUTPUT_DIR, "results.json")
POST_PROGRESS_FILE = os.path.join(OUTPUT_DIR, "post_progress.json")
DEBUG_SCREENSHOT_DIR = os.path.join(OUTPUT_DIR, "screenshots")
os.makedirs(DEBUG_SCREENSHOT_DIR, exist_ok=True)

# Global States
logs: List[Dict[str, Any]] = []
bot_status = "Idle"
run_mode = "Real Browser"
current_coin_name = "N/A"
is_posting_running = False
current_posting_index = 0
consecutive_failures = 0

def add_log(log_type: str, text: str):
    """Logs a formatted message to console and in-memory list."""
    timestamp = datetime.now().strftime("%I:%M:%S %p")
    log_entry = {
        "type": log_type,  # success, info, warning, error
        "text": text,
        "timestamp": timestamp
    }
    logs.append(log_entry)
    if len(logs) > 1000:
        logs.pop(0)
    
    # Print with ANSI colors in terminal
    color_map = {
        "success": "\033[92m",
        "info": "\033[94m",
        "warning": "\033[93m",
        "error": "\033[91m"
    }
    color = color_map.get(log_type, "\033[0m")
    print(f"{color}[{log_type.upper()}] {text}\033[0m")

add_log("info", "Starting CoinMarketCap Bot Python Backend...")

# Utility Functions
def read_json_file(filepath: str, default_val: Any) -> Any:
    if not os.path.exists(filepath):
        return default_val
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Error reading {filepath}: {e}")
        return default_val

def write_json_file(filepath: str, data: Any):
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Error writing {filepath}: {e}")

def is_openai_configured() -> bool:
    key = os.getenv("OPENAI_API_KEY", "")
    return bool(key and "*" not in key and key.strip())

def is_gemini_configured() -> bool:
    key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY", "")
    return bool(key and "*" not in key and key.strip())

def is_cmc_configured() -> bool:
    key = os.getenv("CMC_API_KEY", "")
    return bool(key and "*" not in key and key.strip())

# Playwright Helpers
async def save_debug_screenshot(page, name: str):
    try:
        filename = f"debug_{name}_{int(datetime.now().timestamp())}.png"
        filepath = os.path.join(DEBUG_SCREENSHOT_DIR, filename)
        await page.screenshot(path=filepath, full_page=False)
        add_log("info", f"Saved debug screenshot to {filepath}")
    except Exception as e:
        add_log("warning", f"Could not capture screenshot: {str(e)}")

async def detect_captcha(page) -> bool:
    try:
        title = await page.title() or ""
        if "cloudflare" in title.lower() or "just a moment" in title.lower():
            return True
        
        # Check Cloudflare challenge selectors
        cf_elements_count = await page.locator('#challenge-running, #challenge-stage, .cf-turnstile, iframe[src*="challenge"], iframe[src*="turnstile"]').count()
        if cf_elements_count > 0:
            return True
            
        body_text = (await page.locator("body").inner_text() or "").lower()
        explicit_phrases = [
            "verify you are human",
            "verify you are a human",
            "checking your browser before accessing",
            "checking your browser...",
            "are you a robot",
            "captcha challenge",
            "solve the captcha",
            "security challenge to proceed",
        ]
        return any(phrase in body_text for phrase in explicit_phrases)
    except Exception:
        return False

async def check_login_real() -> Dict[str, Any]:
    from playwright.async_api import async_playwright
    add_log("info", "Launching headless browser to check login state...")
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-web-security"]
        )
        try:
            if os.path.exists(AUTH_STATE_FILE):
                context = await browser.new_context(
                    storage_state=AUTH_STATE_FILE,
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    viewport={"width": 1280, "height": 800}
                )
            else:
                context = await browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    viewport={"width": 1280, "height": 800}
                )
            
            page = await context.new_page()
            add_log("info", "Navigating to CoinMarketCap home page...")
            await page.goto("https://coinmarketcap.com/", wait_until="commit", timeout=25000)
            await asyncio.sleep(2)
            
            if await detect_captcha(page):
                add_log("error", "Cloudflare human challenge detected on CoinMarketCap!")
                return {"status": "captcha", "message": "Cloudflare Turnstile captcha block"}
                
            page_text = (await page.locator("body").inner_text() or "").lower()
            is_logged_in = any(x in page_text for x in ["watchlist", "portfolio", "avatar", "log out"])
            
            if is_logged_in:
                add_log("success", "Active login session verified!")
                return {"status": "success", "message": "Logged in successfully"}
            else:
                add_log("warning", "Login session expired or user is not logged in.")
                return {"status": "expired", "message": "Not logged in"}
        except Exception as e:
            add_log("error", f"Error during login check: {str(e)}")
            return {"status": "failed", "message": str(e)}
        finally:
            await browser.close()

# Coin & Scraping Helpers
async def execute_fetch_trending() -> List[Dict[str, Any]]:
    global bot_status
    add_log("info", "Starting cryptocurrency listings fetch (Prioritizing CoinMarketCap Trending 50)...")
    bot_status = "Fetching"
    
    coins = []
    success_source = ""
    
    # STAGE 1: Try CoinMarketCap Public Data API
    try:
        add_log("info", "Stage 1: Attempting CoinMarketCap Public Data API...")
        import urllib.request
        req = urllib.request.Request(
            "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/trending/most-visited?limit=50&timeRange=24h",
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept": "application/json"
            }
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            if response.status == 200:
                data = json.loads(response.read().decode('utf-8'))
                raw_list = data.get("data", {}).get("cryptoCurrencyList", [])
                if raw_list:
                    for index, item in enumerate(raw_list):
                        quotes = item.get("quotes", [{}])
                        usd_quote = quotes[0] if quotes else {}
                        coins.append({
                            "name": item.get("name", ""),
                            "symbol": item.get("symbol", "").upper(),
                            "price": usd_quote.get("price", 0),
                            "change_24h": usd_quote.get("percentChange24h", 0),
                            "change_1h": usd_quote.get("percentChange1h", 0),
                            "change_7d": usd_quote.get("percentChange7d", 0),
                            "market_cap": usd_quote.get("marketCap", 0),
                            "volume_24h": usd_quote.get("volume24h", 0),
                            "cmc_rank": item.get("cmcRank") or (index + 1),
                            "slug": item.get("slug", ""),
                            "url": f"https://coinmarketcap.com/currencies/{item.get('slug', '')}/"
                        })
                    success_source = "CoinMarketCap Public Data API"
    except Exception as e:
        add_log("warning", f"Stage 1 failed: {str(e)}")
        
    # STAGE 3: Use official Pro API if key is present
    if not coins and is_cmc_configured():
        try:
            add_log("info", "Stage 3: Attempting CoinMarketCap Pro API...")
            import urllib.request
            req = urllib.request.Request(
                "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=50&sort=volume_24h",
                headers={"X-CMC_PRO_API_KEY": os.getenv("CMC_API_KEY", "")}
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                if response.status == 200:
                    data = json.loads(response.read().decode('utf-8'))
                    raw_list = data.get("data", [])
                    for index, item in enumerate(raw_list):
                        quote = item.get("quote", {}).get("USD", {})
                        coins.append({
                            "name": item.get("name", ""),
                            "symbol": item.get("symbol", "").upper(),
                            "price": quote.get("price", 0),
                            "change_24h": quote.get("percent_change_24h", 0),
                            "change_1h": quote.get("percent_change_1h", 0),
                            "change_7d": quote.get("percent_change_7d", 0),
                            "market_cap": quote.get("market_cap", 0),
                            "volume_24h": quote.get("volume_24h", 0),
                            "cmc_rank": index + 1,
                            "slug": item.get("slug", ""),
                            "url": f"https://coinmarketcap.com/currencies/{item.get('slug', '')}/"
                        })
                    success_source = "CoinMarketCap Pro API (Listings)"
        except Exception as e:
            add_log("warning", f"Stage 3 failed: {str(e)}")

    # STAGE 4: Try CoinGecko Public Markets API
    if not coins:
        try:
            add_log("info", "Stage 4: Attempting fetch from CoinGecko Public Markets API...")
            import urllib.request
            req = urllib.request.Request(
                "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=1h,24h,7d",
                headers={"User-Agent": "Mozilla/5.0"}
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                if response.status == 200:
                    cg_data = json.loads(response.read().decode('utf-8'))
                    for index, coin in enumerate(cg_data):
                        coins.append({
                            "name": coin.get("name", ""),
                            "symbol": coin.get("symbol", "").upper(),
                            "price": coin.get("current_price", 0),
                            "change_24h": coin.get("price_change_percentage_24h") or 0,
                            "change_1h": coin.get("price_change_percentage_1h_in_currency") or 0,
                            "change_7d": coin.get("price_change_percentage_7d_in_currency") or 0,
                            "market_cap": coin.get("market_cap", 0),
                            "volume_24h": coin.get("total_volume", 0),
                            "cmc_rank": index + 1,
                            "slug": coin.get("id", ""),
                            "url": f"https://coinmarketcap.com/currencies/{coin.get('id', '')}/"
                        })
                    success_source = "CoinGecko Markets API"
        except Exception as e:
            add_log("warning", f"Stage 4 failed: {str(e)}")

    # STAGE 5: Load local cache
    if not coins:
        try:
            add_log("info", "Stage 5: Attempting to load from local cached trending coins...")
            cached = read_json_file(LAST_TRENDING_FILE, [])
            if cached:
                coins = cached
                success_source = "Local Cache File (last_trending.json)"
        except Exception as e:
            add_log("warning", f"Stage 5 failed: {str(e)}")

    # STAGE 6: High-fidelity simulated backup
    if not coins:
        add_log("warning", "Stage 6 Fallback triggered. Creating high-fidelity simulated trending coin list...")
        import random
        mock_raw = [
            {"name": "Bitcoin", "symbol": "BTC", "price": 96420, "change_24h": 3.42, "cap": 1890000000000, "vol": 45000000000, "slug": "bitcoin"},
            {"name": "Ethereum", "symbol": "ETH", "price": 3450, "change_24h": -1.24, "cap": 415000000000, "vol": 18000000000, "slug": "ethereum"},
            {"name": "Solana", "symbol": "SOL", "price": 186.4, "change_24h": 8.76, "cap": 87000000000, "vol": 450000000, "slug": "solana"},
            {"name": "Binance Coin", "symbol": "BNB", "price": 615.2, "change_24h": 0.85, "cap": 90000000000, "vol": 1200000000, "slug": "bnb"},
            {"name": "Ripple", "symbol": "XRP", "price": 1.14, "change_24h": 12.15, "cap": 65000000000, "vol": 3200000000, "slug": "xrp"},
            {"name": "Dogecoin", "symbol": "DOGE", "price": 0.385, "change_24h": -4.12, "cap": 56000000000, "vol": 2800000000, "slug": "dogecoin"},
            {"name": "Cardano", "symbol": "ADA", "price": 0.72, "change_24h": 5.34, "cap": 25000000000, "vol": 850000000, "slug": "cardano"},
            {"name": "Avalanche", "symbol": "AVAX", "price": 34.15, "change_24h": -2.31, "cap": 14000000000, "vol": 420000000, "slug": "avalanche"},
            {"name": "Chainlink", "symbol": "LINK", "price": 22.45, "change_24h": 6.89, "cap": 13500000000, "vol": 610000000, "slug": "chainlink"},
            {"name": "Polkadot", "symbol": "DOT", "price": 6.12, "change_24h": 1.45, "cap": 8500000000, "vol": 180000000, "slug": "polkadot"}
        ]
        for index, item in enumerate(mock_raw):
            fluctuation = (random.random() - 0.5) * 0.01
            final_price = round(item["price"] * (1 + fluctuation), 2 if item["price"] > 100 else 4)
            final_change = round(item["change_24h"] + fluctuation * 100, 2)
            coins.append({
                "name": item["name"],
                "symbol": item["symbol"],
                "price": final_price,
                "change_24h": final_change,
                "change_1h": round(fluctuation * 100, 2),
                "change_7d": 0.0,
                "market_cap": item["cap"],
                "volume_24h": item["vol"],
                "cmc_rank": index + 1,
                "slug": item["slug"],
                "url": f"https://coinmarketcap.com/currencies/{item['slug']}/"
            })
        success_source = "Dynamic High-Fidelity Simulated Market Source"
        
    write_json_file(LAST_TRENDING_FILE, coins)
    add_log("success", f"Successfully loaded {len(coins)} trending coins from {success_source}.")
    bot_status = "Idle"
    return coins

# Message Generation Helpers
async def execute_generate_messages() -> List[Dict[str, Any]]:
    global bot_status
    add_log("info", "Starting community comments generation...")
    bot_status = "Generating"
    
    coins = read_json_file(LAST_TRENDING_FILE, [])
    if not coins:
        add_log("error", "No trending coins found. Please fetch trending coins first.")
        bot_status = "Idle"
        raise Exception("Trending coins list is empty.")
        
    generated_messages = []
    openai_failed = False
    
    # Try OpenAI
    if is_openai_configured():
        try:
            add_log("info", "Initializing OpenAI SDK with gpt-4o-mini...")
            from openai import OpenAI
            client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            
            batch_size = 10
            for i in range(0, len(coins), batch_size):
                chunk = coins[i:i+batch_size]
                add_log("info", f"Generating batch {i//batch_size + 1}/{(len(coins)-1)//batch_size + 1} with OpenAI gpt-4o-mini...")
                
                prompt = f"""
                Generate ONE unique, creative, organic CoinMarketCap community comment for EACH of the following coins based on their recent market data.

                Requirements:
                - 1 to 2 short sentences.
                - Write in a natural, human-like voice of an active crypto community trader (sometimes casual, sometimes analytical).
                - Mention the coin name or symbol naturally.
                - Incorporate the provided market price, rank or change percentage naturally.
                - Do NOT use emojis. Do NOT use hashtags.
                - No generic templates or identical sentence structures. Keep comments varied!
                - Never offer professional financial advice. Do not say "this is not financial advice".

                Provide the output as a valid JSON object matching this schema:
                {{
                  "messages": [
                    {{
                      "symbol": "BTC",
                      "message": "Actual comment text here"
                    }}
                  ]
                }}

                Coins list:
                {json.dumps([{"name": c["name"], "symbol": c["symbol"], "price": c["price"], "change_24h": c["change_24h"], "rank": c["cmc_rank"]} for c in chunk])}
                """
                
                completion = client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": prompt}],
                    response_format={"type": "json_object"},
                    temperature=0.8,
                    max_tokens=4000
                )
                
                raw_text = completion.choices[0].message.content or "{}"
                parsed = json.loads(raw_text.strip())
                for msg in parsed.get("messages", []):
                    match = next((c for c in chunk if c["symbol"].lower() == msg.get("symbol", "").lower()), None)
                    if match:
                        generated_messages.append({
                            "name": match["name"],
                            "symbol": match["symbol"],
                            "url": match["url"],
                            "message": msg.get("message", "")
                        })
        except Exception as e:
            add_log("error", f"OpenAI API generation failed: {str(e)}")
            openai_failed = True

    # Try Gemini as backup or primary
    gemini_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if (not is_openai_configured() or openai_failed) and is_gemini_configured():
        try:
            add_log("info", "Using Gemini API (gemini-2.5-flash) as the primary/fallback generator...")
            from google import genai
            from google.genai import types
            
            client = genai.Client(api_key=gemini_key)
            
            batch_size = 10
            for i in range(0, len(coins), batch_size):
                chunk = coins[i:i+batch_size]
                add_log("info", f"Generating batch {i//batch_size + 1}/{(len(coins)-1)//batch_size + 1} with Gemini...")
                
                prompt = f"""
                Generate ONE unique, creative, organic CoinMarketCap community comment for EACH of the following coins based on their recent market data.

                Requirements:
                - 1 to 2 short sentences.
                - Write in a natural, human-like voice of an active crypto community trader (sometimes casual, sometimes analytical).
                - Mention the coin name or symbol naturally.
                - Incorporate the provided market price, rank or change percentage naturally.
                - Do NOT use emojis. Do NOT use hashtags.
                - No generic templates or identical sentence structures. Keep comments varied!
                - Never offer professional financial advice. Do not say "this is not financial advice".

                Provide the output as a valid JSON object matching this schema:
                {{
                  "messages": [
                    {{
                      "symbol": "BTC",
                      "message": "Actual comment text here"
                    }}
                  ]
                }}

                Coins list:
                {json.dumps([{"name": c["name"], "symbol": c["symbol"], "price": c["price"], "change_24h": c["change_24h"], "rank": c["cmc_rank"]} for c in chunk])}
                """
                
                response = client.models.generate_content(
                    model='gemini-2.5-flash',
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0.8
                    )
                )
                
                raw_text = response.text or "{}"
                parsed = json.loads(raw_text.strip())
                for msg in parsed.get("messages", []):
                    match = next((c for c in chunk if c["symbol"].lower() == msg.get("symbol", "").lower()), None)
                    if match:
                        generated_messages.append({
                            "name": match["name"],
                            "symbol": match["symbol"],
                            "url": match["url"],
                            "message": msg.get("message", "")
                        })
        except Exception as e:
            add_log("error", f"Gemini API generation failed: {str(e)}")

    # Simple local backup generator if APIs are not configured
    if not generated_messages:
        add_log("warning", "No AI API configured or calls failed. Generating human-curated comments locally...")
        for c in coins:
            price_str = f"${c['price']:,.2f}" if c['price'] >= 1 else f"${c['price']:.6f}"
            change_str = f"+{c['change_24h']}%" if c['change_24h'] >= 0 else f"{c['change_24h']}%"
            sentiment_phrase = "looking super strong today" if c['change_24h'] >= 0 else "decent buying opportunity here"
            generated_messages.append({
                "name": c["name"],
                "symbol": c["symbol"],
                "url": c["url"],
                "message": f"Solid price action for {c['name']} ({c['symbol']}) sitting around {price_str}, {sentiment_phrase} with a 24h change of {change_str}."
            })
            
    write_json_file(GENERATED_MESSAGES_FILE, generated_messages)
    add_log("success", f"Successfully saved {len(generated_messages)} community comments.")
    bot_status = "Idle"
    return generated_messages

# Posting Automations
async def run_real_posting_with_page(page, url: str, message: str) -> Dict[str, Any]:
    try:
        add_log("info", f"Navigating to coin detail page: {url}")
        await page.goto(url, wait_until="commit", timeout=30000)
        await asyncio.sleep(4)
        
        # Check Cloudflare
        if await detect_captcha(page):
            return {"status": "captcha", "message": "Blocked by Cloudflare challenge"}
            
        # Detect Comment editor
        add_log("info", "Locating comment input field...")
        editor_selectors = [
            'div[contenteditable="true"]',
            '.public-DraftEditor-content',
            '.tiptap',
            '.ProseMirror',
            'textarea[placeholder*="comment"]',
            'textarea[placeholder*="thoughts"]',
            '[data-test="editor-input"]'
        ]
        
        editor = None
        for sel in editor_selectors:
            locator = page.locator(sel).first
            if await locator.count() > 0:
                editor = locator
                break
                
        if not editor:
            await save_debug_screenshot(page, "editor_not_found")
            if await detect_captcha(page):
                return {"status": "captcha", "message": "Blocked by Cloudflare challenge"}
            return {"status": "failed", "message": "Could not locate community post editor"}
            
        add_log("info", "Focusing editor and typing comment message...")
        await editor.click()
        await asyncio.sleep(0.5)
        
        # Clear editor first if any placeholder text is inside
        await editor.fill("")
        await editor.type(message, delay=40)
        await asyncio.sleep(1)
        
        # Bullish Toggle
        add_log("info", "Checking Bullish sentiment option...")
        bullish_selectors = [
            'button:has-text("Bullish")',
            '.sentiment-bullish',
            '[data-test="sentiment-bullish"]',
            'button.bullish',
            'span:has-text("Bull"), span:has-text("Bullish")'
        ]
        
        bullish_btn = None
        for sel in bullish_selectors:
            locator = page.locator(sel).first
            if await locator.count() > 0:
                bullish_btn = locator
                break
                
        if bullish_btn:
            add_log("info", "Clicking Bullish toggle...")
            await bullish_btn.click(force=True, timeout=3000)
            await asyncio.sleep(0.5)
            
        # Submit Button
        add_log("info", "Locating submission button...")
        submit_selectors = [
            '[data-test="editor-post-button"]',
            'button:has-text("Post")',
            'button:has-text("Submit")',
            'button:has-text("Comment")',
            '.editor-post-button'
        ]
        
        submit_btn = None
        for sel in submit_selectors:
            locator = page.locator(sel).first
            if await locator.count() > 0:
                submit_btn = locator
                break
                
        if not submit_btn:
            await save_debug_screenshot(page, "submit_button_missing")
            return {"status": "failed", "message": "Submission button not found"}
            
        # Check if button text indicates logged out
        btn_text = await submit_btn.inner_text() or ""
        if any(x in btn_text.lower() for x in ["log in", "signin"]):
            return {"status": "expired", "message": "Post button indicates user is logged out"}
            
        add_log("info", "Submitting comment...")
        await submit_btn.click(force=True, timeout=5000)
        await asyncio.sleep(4)
        
        # Captcha checks after post click
        if await detect_captcha(page):
            return {"status": "captcha", "message": "Captcha requested on submit"}
            
        # Check body text for limits
        body_text_after = (await page.locator("body").inner_text() or "").lower()
        rate_limit_phrases = ["too many requests", "posting too fast", "try again later", "posting too frequently", "rate limit", "slow down"]
        if any(p in body_text_after for p in rate_limit_phrases):
            return {"status": "retry", "message": "Submission rate limit triggered"}
            
        add_log("success", "Comment submitted successfully!")
        return {"status": "success", "message": "Posted successfully"}
        
    except Exception as e:
        add_log("error", f"Error in Playwright posting: {str(e)}")
        return {"status": "failed", "message": str(e)}

async def posting_background_task():
    global bot_status, is_posting_running, current_posting_index, current_coin_name, consecutive_failures
    
    from playwright.async_api import async_playwright
    
    messages = read_json_file(GENERATED_MESSAGES_FILE, [])
    results = read_json_file(RESULTS_FILE, [])
    
    add_log("info", f"Starting background posting loop with {len(messages)} messages...")
    bot_status = "Posting"
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-web-security"]
        )
        try:
            # Create authenticated context
            if os.path.exists(AUTH_STATE_FILE):
                context = await browser.new_context(
                    storage_state=AUTH_STATE_FILE,
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    viewport={"width": 1280, "height": 800}
                )
            else:
                context = await browser.new_context(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    viewport={"width": 1280, "height": 800}
                )
                
            page = await context.new_page()
            
            while is_posting_running and current_posting_index < len(messages):
                if consecutive_failures >= 3:
                    add_log("error", "3 consecutive failures detected. Stopping queue to prevent account issues.")
                    break
                    
                item = messages[current_posting_index]
                current_coin_name = f"{item['name']} ({item['symbol']})"
                add_log("info", f"--- Queue Progress: {current_posting_index+1}/{len(messages)} | Current: {current_coin_name} ---")
                
                outcome = await run_real_posting_with_page(page, item["url"], item["message"])
                status_val = outcome["status"]
                
                if status_val == "success":
                    consecutive_failures = 0
                    results.append({
                        "name": item["name"],
                        "symbol": item["symbol"],
                        "url": item["url"],
                        "status": "success",
                        "message": "Posted successfully",
                        "timestamp": datetime.now().strftime("%I:%M:%S %p")
                    })
                elif status_val == "retry":
                    consecutive_failures += 1
                    add_log("warning", f"Rate limit on submission. Skipped {item['symbol']} to avoid blocking.")
                    results.append({
                        "name": item["name"],
                        "symbol": item["symbol"],
                        "url": item["url"],
                        "status": "rate_limited",
                        "message": "Skipped due to rate limit",
                        "timestamp": datetime.now().strftime("%I:%M:%S %p")
                    })
                elif status_val == "captcha":
                    add_log("error", "Captcha detected! Stopping loop for safety.")
                    results.append({
                        "name": item["name"],
                        "symbol": item["symbol"],
                        "url": item["url"],
                        "status": "captcha",
                        "message": "Blocked by captcha",
                        "timestamp": datetime.now().strftime("%I:%M:%S %p")
                    })
                    break
                elif status_val == "expired":
                    add_log("error", "Session state is expired or logged out! Stopping queue.")
                    results.append({
                        "name": item["name"],
                        "symbol": item["symbol"],
                        "url": item["url"],
                        "status": "expired",
                        "message": "Session expired or logged out",
                        "timestamp": datetime.now().strftime("%I:%M:%S %p")
                    })
                    break
                else:
                    consecutive_failures += 1
                    results.append({
                        "name": item["name"],
                        "symbol": item["symbol"],
                        "url": item["url"],
                        "status": "failed",
                        "message": outcome.get("message", "Unknown error"),
                        "timestamp": datetime.now().strftime("%I:%M:%S %p")
                    })
                    
                write_json_file(RESULTS_FILE, results)
                current_posting_index += 1
                write_json_file(POST_PROGRESS_FILE, {"next_index": current_posting_index})
                
                # Human delay
                if is_posting_running and current_posting_index < len(messages):
                    delay = 15
                    add_log("info", f"Waiting {delay} seconds before next item to mimic human behavior...")
                    await asyncio.sleep(delay)
                    
        finally:
            await browser.close()
            
    is_posting_running = False
    bot_status = "Idle"
    current_coin_name = "N/A"
    add_log("success", "Automated posting queue execution has completed.")

# API Route Handlers

@app.get("/api/get-session")
async def get_session():
    exists = os.path.exists(AUTH_STATE_FILE)
    details = {}
    if exists:
        try:
            stats = os.stat(AUTH_STATE_FILE)
            details = {
                "sizeBytes": stats.st_size,
                "updatedAt": datetime.fromtimestamp(stats.st_mtime).isoformat()
            }
        except Exception:
            pass
    return {
        "exists": exists,
        "filePath": AUTH_STATE_FILE,
        "details": details
    }

@app.post("/api/save-session")
async def save_session(payload: Dict[str, Any] = Body(...)):
    state_json = payload.get("stateJson")
    if not state_json:
        raise HTTPException(status_code=400, detail="Missing stateJson payload")
    try:
        json.loads(state_json) # Verify JSON structure
        with open(AUTH_STATE_FILE, "w", encoding="utf-8") as f:
            f.write(state_json)
        add_log("success", "Successfully updated browser auth state (auth/state.json).")
        return {"success": True, "message": "auth/state.json saved successfully."}
    except Exception as e:
        add_log("error", f"Failed to save session state: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Invalid JSON format: {str(e)}")

@app.post("/api/clear-session")
async def clear_session():
    try:
        if os.path.exists(AUTH_STATE_FILE):
            os.remove(AUTH_STATE_FILE)
            add_log("warning", "Deleted auth/state.json session state.")
            return {"success": True, "message": "Session state deleted."}
        return {"success": True, "message": "No session state existed to delete."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/data/trending-coins")
async def get_trending_coins():
    return read_json_file(LAST_TRENDING_FILE, [])

@app.get("/api/data/generated-messages")
async def get_generated_messages():
    return read_json_file(GENERATED_MESSAGES_FILE, [])

@app.post("/api/save-trending-coins")
async def save_trending_coins(payload: Dict[str, Any] = Body(...)):
    coins = payload.get("coins")
    if isinstance(coins, list):
        write_json_file(LAST_TRENDING_FILE, coins)
        add_log("success", f"Restored {len(coins)} trending coins from browser cache storage.")
        return {"success": True}
    raise HTTPException(status_code=400, detail="Invalid coins payload")

@app.post("/api/save-generated-messages")
async def save_generated_messages(payload: Dict[str, Any] = Body(...)):
    messages = payload.get("messages")
    if isinstance(messages, list):
        write_json_file(GENERATED_MESSAGES_FILE, messages)
        add_log("success", f"Restored {len(messages)} generated comments from browser cache storage.")
        return {"success": True}
    raise HTTPException(status_code=400, detail="Invalid messages payload")

@app.post("/api/save-results")
async def save_results(payload: Dict[str, Any] = Body(...)):
    results = payload.get("results")
    if isinstance(results, list):
        write_json_file(RESULTS_FILE, results)
        return {"success": True}
    raise HTTPException(status_code=400, detail="Invalid results payload")

@app.post("/api/save-progress")
async def save_progress(payload: Dict[str, Any] = Body(...)):
    global current_posting_index
    index = payload.get("index")
    if isinstance(index, int):
        write_json_file(POST_PROGRESS_FILE, {"next_index": index})
        current_posting_index = index
        return {"success": True}
    raise HTTPException(status_code=400, detail="Invalid index payload")

@app.get("/api/status")
async def get_status():
    coins = read_json_file(LAST_TRENDING_FILE, [])
    messages = read_json_file(GENERATED_MESSAGES_FILE, [])
    results = read_json_file(RESULTS_FILE, [])
    progress = read_json_file(POST_PROGRESS_FILE, {"next_index": 0})
    
    session_exists = os.path.exists(AUTH_STATE_FILE)
    return {
        "status": bot_status,
        "runMode": run_mode,
        "totalCoins": len(coins),
        "generatedMessages": len(messages),
        "postedCount": len([r for r in results if r.get("status") == "success"]),
        "failedCount": len([r for r in results if r.get("status") != "success"]),
        "results": results,
        "progressIndex": progress.get("next_index", 0),
        "currentCoin": current_coin_name,
        "sessionStatus": "Session active" if session_exists else "Session expired / Not found",
        "apiStatus": {
            "openai": is_openai_configured(),
            "cmc": is_cmc_configured()
        }
    }

@app.post("/api/set-run-mode")
async def set_run_mode():
    add_log("info", "Bot run mode is hard-locked to Real Browser. Simulation mode is disabled.")
    return {"success": True, "runMode": "Real Browser"}

@app.post("/api/check-login")
async def check_login():
    global bot_status
    bot_status = "Checking Login"
    if not os.path.exists(AUTH_STATE_FILE):
        add_log("error", "Login check failed: auth/state.json does not exist. Please upload active session cookies.")
        bot_status = "Idle"
        return {"status": "expired", "message": "auth/state.json missing"}
        
    try:
        result = await check_login_real()
        bot_status = "Idle"
        return result
    except Exception as e:
        add_log("error", f"Real login verification failed: {str(e)}")
        bot_status = "Idle"
        return {"status": "failed", "message": str(e)}

@app.post("/api/fetch-trending")
async def fetch_trending_route():
    try:
        coins = await execute_fetch_trending()
        return {"status": "success", "coins": coins}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-messages")
async def generate_messages_route():
    try:
        messages = await execute_generate_messages()
        return {"status": "success", "messages": messages}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/post-chat")
async def post_chat_route(background_tasks: BackgroundTasks):
    global is_posting_running, current_posting_index
    if is_posting_running:
        return {"status": "error", "message": "Queue is already active."}
        
    messages = read_json_file(GENERATED_MESSAGES_FILE, [])
    if not messages:
        raise HTTPException(status_code=400, detail="No comments found. Generate comments first.")
        
    progress = read_json_file(POST_PROGRESS_FILE, {"next_index": 0})
    current_posting_index = progress.get("next_index", 0)
    
    if current_posting_index >= len(messages):
        current_posting_index = 0
        write_json_file(POST_PROGRESS_FILE, {"next_index": 0})
        
    is_posting_running = True
    background_tasks.add_task(posting_background_task)
    
    return {
        "status": "success",
        "message": "Automated queue scheduler is running",
        "startIndex": current_posting_index
    }

@app.post("/api/stop-posting")
async def stop_posting():
    global is_posting_running, bot_status
    is_posting_running = False
    bot_status = "Idle"
    add_log("warning", "Automated posting sequence has been manually stopped/paused.")
    return {"success": True, "message": "Posting sequence stopped."}

@app.post("/api/skip-coin")
async def skip_coin():
    global current_posting_index
    messages = read_json_file(GENERATED_MESSAGES_FILE, [])
    if current_posting_index < len(messages):
        skipped = messages[current_posting_index]
        add_log("warning", f"MANUAL ACTION: Skipping {skipped['symbol']} ({skipped['name']}) on demand.")
        current_posting_index += 1
        write_json_file(POST_PROGRESS_FILE, {"next_index": current_posting_index})
        return {"success": True, "message": f"Skipped {skipped['symbol']}. Next index: {current_posting_index}", "nextIndex": current_posting_index}
    raise HTTPException(status_code=400, detail="Cannot skip. Already at the end of the batch!")

@app.post("/api/reset-progress")
async def reset_progress():
    global current_posting_index
    current_posting_index = 0
    write_json_file(POST_PROGRESS_FILE, {"next_index": 0})
    add_log("info", "MANUAL ACTION: Posting progress index reset to 0.")
    return {"success": True, "message": "Posting progress reset to 0.", "nextIndex": 0}

@app.post("/api/full-flow")
async def full_flow(background_tasks: BackgroundTasks):
    global bot_status, current_posting_index
    add_log("info", "========================================")
    add_log("info", "Starting Full Bot Flow End-to-End Sequence...")
    add_log("info", "========================================")
    
    try:
        write_json_file(RESULTS_FILE, [])
        write_json_file(POST_PROGRESS_FILE, {"next_index": 0})
        current_posting_index = 0
        
        # Async tasks running sequentially
        await execute_fetch_trending()
        await execute_generate_messages()
        
        # Start background poster
        is_posting_running = True
        background_tasks.add_task(posting_background_task)
        
        return {
            "success": True,
            "message": "End-to-End sequence started successfully. Monitoring logs...",
            "startIndex": 0
        }
    except Exception as e:
        add_log("error", f"Full Flow failed: {str(e)}")
        bot_status = "Idle"
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/clear-all")
async def clear_all():
    global logs, current_posting_index, current_coin_name, bot_status, consecutive_failures
    try:
        logs.clear()
        write_json_file(LAST_TRENDING_FILE, [])
        write_json_file(GENERATED_MESSAGES_FILE, [])
        write_json_file(RESULTS_FILE, [])
        write_json_file(POST_PROGRESS_FILE, {"next_index": 0})
        current_posting_index = 0
        consecutive_failures = 0
        current_coin_name = "N/A"
        bot_status = "Idle"
        add_log("success", "Console cleared. Reset trending data, comments, and results.")
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/logs")
async def get_logs_endpoint():
    return logs

# CSV Downloads
@app.get("/api/download/trending_coins.csv")
async def download_trending_coins():
    coins = read_json_file(LAST_TRENDING_FILE, [])
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Rank", "Name", "Symbol", "Price (USD)", "Change 24h (%)", "Market Cap", "Volume 24h", "URL"])
    for c in coins:
        writer.writerow([c.get("cmc_rank"), c.get("name"), c.get("symbol"), c.get("price"), c.get("change_24h"), c.get("market_cap"), c.get("volume_24h"), c.get("url")])
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=trending_coins.csv"}
    )

@app.get("/api/download/duplicate_urls.csv")
async def download_duplicate_urls():
    coins = read_json_file(LAST_TRENDING_FILE, [])
    urls = [c.get("url") for c in coins if c.get("url")]
    dupes = [u for u in set(urls) if urls.count(u) > 1]
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Duplicate URL", "Occurrences"])
    for d in dupes:
        writer.writerow([d, urls.count(d)])
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=duplicate_urls.csv"}
    )

@app.get("/api/download/duplicate_names.csv")
async def download_duplicate_names():
    coins = read_json_file(LAST_TRENDING_FILE, [])
    names = [c.get("name") for c in coins if c.get("name")]
    dupes = [n for n in set(names) if names.count(n) > 1]
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Duplicate Name", "Occurrences"])
    for d in dupes:
        writer.writerow([d, names.count(d)])
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=duplicate_names.csv"}
    )

@app.get("/api/download/duplicate_symbols.csv")
async def download_duplicate_symbols():
    coins = read_json_file(LAST_TRENDING_FILE, [])
    symbols = [c.get("symbol") for c in coins if c.get("symbol")]
    dupes = [s for s in set(symbols) if symbols.count(s) > 1]
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Duplicate Symbol", "Occurrences"])
    for d in dupes:
        writer.writerow([d, symbols.count(d)])
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=duplicate_symbols.csv"}
    )

# Static file server with catch-all fallback for SPA routing
frontend_dist_path = os.path.join(os.getcwd(), "dist")
if os.path.exists(frontend_dist_path):
    @app.get("/{fallback_path:path}")
    async def fallback_spa(fallback_path: str):
        # If the requested path is a file in the dist folder, serve it
        file_path = os.path.join(frontend_dist_path, fallback_path)
        if fallback_path and os.path.isfile(file_path):
            return FileResponse(file_path)
        # Otherwise, fall back to index.html for client-side routing
        return FileResponse(os.path.join(frontend_dist_path, "index.html"))

if __name__ == "__main__":
    import uvicorn
    # Bind to port from env variable or default to 3000
    port = int(os.getenv("PORT", "3000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
