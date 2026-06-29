/**
 * Financial data fetcher — cloud-safe priority chain:
 *
 *  1. Polygon.io     — free tier, no IP blocks, great for US/global stocks
 *  2. Tavily scrape  — extracts financials from web results (works everywhere)
 *  3. Alpha Vantage  — last resort, 25 req/day free
 */

import { searchTavily } from "./tavilySearch.js";

// ─────────────────────────────────────────────────────────────────────────────
// Key helpers
// ─────────────────────────────────────────────────────────────────────────────

function getKeys(baseName) {
  const keys = ["", "_1", "_2", "_3", "_4"]
    .map((s) => process.env[`${baseName}${s}`]?.trim())
    .filter((k) => k && !k.startsWith("your_") && k !== "demo");
  return [...new Set(keys)];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Polygon.io  (free tier — unlimited EOD, 5 req/min, no IP blocks)
//    Sign up free at: https://polygon.io/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch quote + details from Polygon for a US ticker.
 * Uses /v2/snapshot/locale/us/markets/stocks/tickers/:ticker
 * and /v3/reference/tickers/:ticker for fundamentals.
 * @param {string} symbol  Plain US ticker, e.g. "AAPL", "CRM"
 * @param {string} apiKey
 * @returns {Promise<object|null>}
 */
async function fetchPolygonData(symbol, apiKey) {
  // Polygon only covers US-listed tickers — skip Indian suffixes
  if (symbol.includes(".")) return null;

  try {
    const [snapRes, detailRes] = await Promise.all([
      fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}?apiKey=${apiKey}`,
        { signal: AbortSignal.timeout(10000) }
      ),
      fetch(
        `https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(symbol)}?apiKey=${apiKey}`,
        { signal: AbortSignal.timeout(10000) }
      ),
    ]);

    if (!snapRes.ok) {
      if (snapRes.status === 429) console.warn(`[Finance] Polygon rate-limited for ${symbol}`);
      else console.warn(`[Finance] Polygon HTTP ${snapRes.status} for ${symbol}`);
      return null;
    }

    const snapJson = await snapRes.json();
    const detailJson = detailRes.ok ? await detailRes.json() : {};

    // Polygon wraps result in { ticker: { ... } }
    const t = snapJson?.ticker;
    const day = t?.day ?? {};
    const prevDay = t?.prevDay ?? {};
    const details = detailJson?.results ?? {};

    const safeNum = (v) =>
      v !== undefined && v !== null && !Number.isNaN(Number(v)) ? Number(v) : null;

    // Use current day price, fall back to prev day close
    const currentPrice = safeNum(day.c ?? prevDay.c);
    const marketCap = safeNum(details.market_cap);

    if (!currentPrice) {
      console.warn(`[Finance] Polygon no price for ${symbol}`);
      return null;
    }

    console.log(`[Finance] Polygon ✓ ${symbol} @ $${currentPrice}`);

    return {
      currentPrice,
      marketCap,
      peRatio: null,          // not on Polygon free tier
      eps: null,
      revenue: null,
      netIncome: null,
      debtToEquity: null,
      profitMargin: null,
      week52High: safeNum(details.week_52_high ?? t?.todaysChangePerc),
      week52Low: safeNum(details.week_52_low),
      analystTargetPrice: null,
      revenueGrowth: null,
      currency: "USD",
      shortName: details.name ?? symbol,
      yahooSymbol: symbol,
      source: "polygon",
    };
  } catch (err) {
    console.warn(`[Finance] Polygon exception for ${symbol}: ${err.message}`);
    return null;
  }
}

async function fetchFromPolygon(symbol) {
  const keys = getKeys("POLYGON_API_KEY");
  if (keys.length === 0) {
    console.warn("[Finance] Polygon skipped — no POLYGON_API_KEY env vars");
    return null;
  }
  console.log(`[Finance] Polygon trying ${symbol} with ${keys.length} key(s)`);
  for (const key of keys) {
    const data = await fetchPolygonData(symbol, key);
    if (data) return data;
  }
  console.warn(`[Finance] Polygon all key(s) failed for ${symbol}`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tavily financial scrape  (works everywhere, extracts from web results)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a numeric value from text using multiple regex patterns.
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {number|null}
 */
function extractNum(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      // Handle B/M/T/K suffixes
      let v = parseFloat(m[1].replace(/,/g, ""));
      const suffix = (m[2] ?? "").toUpperCase();
      if (suffix === "T") v *= 1e12;
      else if (suffix === "B") v *= 1e9;
      else if (suffix === "M") v *= 1e6;
      else if (suffix === "K") v *= 1e3;
      if (!Number.isNaN(v) && v > 0) return v;
    }
  }
  return null;
}

/**
 * Scrape financial metrics from Tavily search results.
 * @param {string} companyName
 * @param {string|null} ticker
 * @param {string|null} exchange
 * @returns {Promise<object|null>}
 */
async function fetchFromTavily(companyName, ticker, exchange) {
  try {
    const isIndian =
      (exchange ?? "").toUpperCase().match(/NSE|BSE|INDIA/) ||
      ticker?.endsWith(".NS") ||
      ticker?.endsWith(".BO");

    const queries = [
      `${companyName} stock price market cap PE ratio 2024`,
      `${ticker ?? companyName} share price today`,
    ];

    const allResults = [];
    for (const q of queries) {
      const results = await searchTavily(q, 5);
      allResults.push(...results);
    }

    if (allResults.length === 0) return null;

    const corpus = allResults
      .map((r) => `${r.title} ${r.snippet}`)
      .join(" ")
      .replace(/[,]/g, "");

    console.log(`[Finance] Tavily scraping financials for ${companyName}`);

    const price = extractNum(corpus, [
      /(?:price|trading at|trades at|last price)[:\s]+[$₹]?\s*([\d.]+)\s*(B|M|K)?/i,
      /[$₹]\s*([\d.]+)\s*(B|M|K)?(?:\s*per share)/i,
      /(?:current price|stock price)[^\d]+([\d.]+)\s*(B|M|K)?/i,
    ]);

    const marketCap = extractNum(corpus, [
      /market cap[^\d]+([\d.]+)\s*(T|B|M|K)?/i,
      /market capitaliz\w+[^\d]+([\d.]+)\s*(T|B|M|K)?/i,
      /mkt cap[^\d]+([\d.]+)\s*(T|B|M|K)?/i,
    ]);

    const peRatio = extractNum(corpus, [
      /p\/e ratio[^\d]+([\d.]+)/i,
      /price.earnings[^\d]+([\d.]+)/i,
      /pe ratio[^\d]+([\d.]+)/i,
      /trailing p\/e[^\d]+([\d.]+)/i,
    ]);

    const eps = extractNum(corpus, [
      /eps[^\d]+([\d.]+)/i,
      /earnings per share[^\d]+([\d.]+)/i,
    ]);

    const revenue = extractNum(corpus, [
      /revenue[^\d]+([\d.]+)\s*(T|B|M|K)?/i,
      /total revenue[^\d]+([\d.]+)\s*(T|B|M|K)?/i,
      /annual revenue[^\d]+([\d.]+)\s*(T|B|M|K)?/i,
    ]);

    const profitMargin = extractNum(corpus, [
      /profit margin[^\d]+([\d.]+)\s*%/i,
      /net margin[^\d]+([\d.]+)\s*%/i,
    ]);

    const week52High = extractNum(corpus, [
      /52.week high[^\d]+([\d.]+)/i,
      /year high[^\d]+([\d.]+)/i,
    ]);

    const week52Low = extractNum(corpus, [
      /52.week low[^\d]+([\d.]+)/i,
      /year low[^\d]+([\d.]+)/i,
    ]);

    // Need at least a price or market cap to be useful
    if (!price && !marketCap) {
      console.warn(`[Finance] Tavily scrape found no price/marketcap for ${companyName}`);
      return null;
    }

    const currency = isIndian ? "INR" : "USD";
    console.log(`[Finance] Tavily ✓ ${companyName} @ ${currency} ${price ?? "?"}`);

    return {
      currentPrice: price,
      marketCap,
      peRatio,
      eps,
      revenue,
      netIncome: revenue && profitMargin ? revenue * (profitMargin / 100) : null,
      debtToEquity: null,
      profitMargin: profitMargin ? profitMargin / 100 : null,
      week52High,
      week52Low,
      analystTargetPrice: null,
      revenueGrowth: null,
      currency,
      shortName: companyName,
      yahooSymbol: ticker ?? companyName,
      source: "tavily",
    };
  } catch (err) {
    console.warn(`[Finance] Tavily scrape error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Alpha Vantage  (last resort — 25 req/day free)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAlphaVantageQuote(symbol, apiKey) {
  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (json["Note"] || json["Information"]) {
      console.warn(`[Finance] AV rate-limited for ${symbol}`);
      return null;
    }
    const q = json["Global Quote"];
    if (!q?.["05. price"]) return null;
    const price = parseFloat(q["05. price"]);
    if (!price) return null;
    console.log(`[Finance] AV ✓ ${symbol} @ ${price}`);
    return {
      currentPrice: price,
      marketCap: null, peRatio: null, eps: null, revenue: null,
      netIncome: null, debtToEquity: null, profitMargin: null,
      week52High: parseFloat(q["03. high"]) || null,
      week52Low: parseFloat(q["04. low"]) || null,
      analystTargetPrice: null, revenueGrowth: null,
      currency: symbol.endsWith(".NS") || symbol.endsWith(".BO") ? "INR" : "USD",
      shortName: symbol,
      yahooSymbol: symbol,
      source: "alphavantage",
    };
  } catch { return null; }
}

async function fetchFromAlphaVantage(symbol) {
  const keys = getKeys("ALPHA_VANTAGE_KEY");
  if (keys.length === 0) return null;
  for (const key of keys) {
    const data = await fetchAlphaVantageQuote(symbol, key);
    if (data) return data;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol helpers
// ─────────────────────────────────────────────────────────────────────────────

const EXCHANGE_SUFFIX = {
  NSE: ".NS", BSE: ".BO", LSE: ".L", LON: ".L",
  TSE: ".T", HKEX: ".HK", ASX: ".AX", TSX: ".TO",
  FRA: ".F", XETRA: ".DE",
};

const INDIAN_NAME_RE =
  /reliance|tata|infosys|wipro|hdfc|icici|bajaj|adani|airtel|hcl|mahindra|kotak|sbi|ongc|itc|hindustan|maruti|ultratech/i;

export function buildYahooSymbols(ticker, exchange = null) {
  if (!ticker) return [];
  const symbols = new Set();
  const upper = ticker.toUpperCase();
  symbols.add(upper);
  if (upper.includes(".")) return [...symbols];

  const exchangeKey = (exchange ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  for (const [key, suffix] of Object.entries(EXCHANGE_SUFFIX)) {
    if (exchangeKey.includes(key)) symbols.add(`${upper}${suffix}`);
  }
  if (exchangeKey.match(/NSE|BSE|INDIA|BOMBAY/)) {
    symbols.add(`${upper}.NS`);
    symbols.add(`${upper}.BO`);
  }
  return [...symbols];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch comprehensive financial data.
 * Priority: Polygon.io → Tavily scrape → Alpha Vantage
 *
 * @param {string}      ticker
 * @param {string|null} exchange
 * @param {string|null} companyName
 * @returns {Promise<object|null>}
 */
export async function fetchFinancialData(ticker, exchange = null, companyName = null) {
  if (!ticker && !companyName) return null;

  const symbolsToTry = buildYahooSymbols(ticker, exchange);

  // Auto-add Indian suffixes for known Indian company names
  if (ticker && !ticker.includes(".") && companyName && INDIAN_NAME_RE.test(companyName)) {
    const upper = ticker.toUpperCase();
    if (!symbolsToTry.includes(`${upper}.NS`)) symbolsToTry.push(`${upper}.NS`);
    if (!symbolsToTry.includes(`${upper}.BO`)) symbolsToTry.push(`${upper}.BO`);
  }

  const bareSymbol = symbolsToTry[0]; // plain ticker without suffix

  // ── 1. Polygon.io (US stocks, free, no IP blocks) ──
  if (bareSymbol && !bareSymbol.includes(".")) {
    const polygonData = await fetchFromPolygon(bareSymbol);
    if (polygonData) return polygonData;
  }

  // ── 2. Tavily financial scrape (works everywhere, global coverage) ──
  const name = companyName ?? ticker;
  if (name) {
    const tavilyData = await fetchFromTavily(name, ticker, exchange);
    if (tavilyData) return tavilyData;
  }

  // ── 3. Alpha Vantage (last resort — 25 req/day) ──
  for (const symbol of symbolsToTry) {
    const avData = await fetchFromAlphaVantage(symbol);
    if (avData) return avData;
  }

  console.error(
    `[Finance] All sources failed for "${ticker ?? companyName}" (tried: ${symbolsToTry.join(", ")})`
  );
  return null;
}
