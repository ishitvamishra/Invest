/**
 * Financial data fetcher — priority chain:
 *
 *  1. RapidAPI Yahoo Finance  — real Yahoo Finance data, no IP blocks, free tier 500 req/month
 *  2. Polygon.io              — price-only fallback for US stocks
 *  3. Alpha Vantage           — last resort, 25 req/day
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
// 1. RapidAPI Yahoo Finance
//    Subscribe free at: https://rapidapi.com/sparior/api/yahoo-finance15
//    Env var: RAPIDAPI_KEY, RAPIDAPI_KEY_1, RAPIDAPI_KEY_2 ...
// ─────────────────────────────────────────────────────────────────────────────

const RAPIDAPI_HOST = "yahoo-finance15.p.rapidapi.com";

/**
 * Fetch full quote summary from RapidAPI Yahoo Finance.
 * Uses /api/v2/markets/tickers which returns rich data on the free tier.
 * @param {string} symbol   e.g. "AAPL", "RELIANCE.NS"
 * @param {string} apiKey
 * @returns {Promise<object|null>}
 */
async function fetchRapidApiQuote(symbol, apiKey) {
  try {
    // Primary: /api/v2/markets/tickers?tickers=SYMBOL (returns array with full quote)
    const res = await fetch(
      `https://${RAPIDAPI_HOST}/api/v2/markets/tickers?tickers=${encodeURIComponent(symbol)}&type=STOCKS`,
      {
        headers: {
          "x-rapidapi-host": RAPIDAPI_HOST,
          "x-rapidapi-key": apiKey,
        },
        signal: AbortSignal.timeout(12000),
      }
    );

    if (!res.ok) {
      console.warn(`[Finance] RapidAPI HTTP ${res.status} for ${symbol}`);
      return null;
    }

    const text = await res.text();
    // Guard against HTML error pages
    if (text.trimStart().startsWith("<")) {
      console.warn(`[Finance] RapidAPI returned HTML for ${symbol} — wrong endpoint or key issue`);
      return null;
    }

    const json = JSON.parse(text);

    if (json?.message || json?.error) {
      console.warn(`[Finance] RapidAPI error for ${symbol}: ${(json.message ?? json.error ?? "").slice(0, 120)}`);
      return null;
    }

    // Response shape: { body: [{ ...quote fields }] } or { data: [...] }
    const items = json?.body ?? json?.data ?? json?.result ?? [];
    const q = Array.isArray(items) ? items[0] : items;

    if (!q) {
      console.warn(`[Finance] RapidAPI empty body for ${symbol}`);
      return null;
    }

    const safeNum = (v) =>
      v !== undefined && v !== null && !Number.isNaN(Number(v)) ? Number(v) : null;

    // Try multiple price field names (API returns different field names)
    const currentPrice = safeNum(
      q.regularMarketPrice ?? 
      q.price ?? 
      q.currentPrice ?? 
      q.lastPrice ??
      q.ask ??
      q.bid ??
      q.open
    );
    
    if (!currentPrice) {
      console.warn(`[Finance] RapidAPI no price for ${symbol}. Response keys: ${Object.keys(q).slice(0, 10).join(", ")}`);
      return null;
    }

    console.log(`[Finance] RapidAPI ✓ ${symbol} @ ${q.currency ?? "USD"} ${currentPrice}`);

    const isIndian = symbol.endsWith(".NS") || symbol.endsWith(".BO");

    return {
      currentPrice,
      marketCap:          safeNum(q.marketCap),
      peRatio:            safeNum(q.trailingPE ?? q.peRatio ?? q.pe),
      eps:                safeNum(q.epsTrailingTwelveMonths ?? q.eps),
      revenue:            safeNum(q.totalRevenue ?? q.revenue),
      netIncome:          safeNum(q.netIncome),
      debtToEquity:       safeNum(q.debtToEquity),
      profitMargin:       safeNum(q.profitMargins ?? q.profitMargin),
      week52High:         safeNum(q.fiftyTwoWeekHigh ?? q.week52High),
      week52Low:          safeNum(q.fiftyTwoWeekLow ?? q.week52Low),
      analystTargetPrice: safeNum(q.targetMeanPrice ?? q.analystTargetPrice),
      revenueGrowth:      safeNum(q.revenueGrowth),
      currency:           q.currency ?? (isIndian ? "INR" : "USD"),
      shortName:          q.shortName ?? q.longName ?? q.displayName ?? symbol,
      yahooSymbol:        symbol,
      source:             "rapidapi-yahoo",
    };
  } catch (err) {
    console.warn(`[Finance] RapidAPI exception for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * Search for a symbol using RapidAPI Yahoo Finance search endpoint.
 * @param {string} query
 * @param {string} apiKey
 * @returns {Promise<string|null>}
 */
async function searchRapidApiSymbol(query, apiKey) {
  try {
    const res = await fetch(
      `https://${RAPIDAPI_HOST}/api/v1/markets/search?search=${encodeURIComponent(query)}`,
      {
        headers: {
          "x-rapidapi-host": RAPIDAPI_HOST,
          "x-rapidapi-key": apiKey,
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;

    const text = await res.text();
    if (text.trimStart().startsWith("<")) return null;
    const json = JSON.parse(text);

    const quotes = json?.body?.quotes ?? json?.body ?? json?.quotes ?? [];
    if (!Array.isArray(quotes) || quotes.length === 0) return null;

    const queryLower = query.toLowerCase();
    const equities = quotes.filter((q) => !q.quoteType || q.quoteType === "EQUITY");
    const match =
      equities.find((q) =>
        (q.shortname ?? q.longname ?? "").toLowerCase().includes(queryLower)
      ) ?? equities[0];

    return match?.symbol ?? null;
  } catch {
    return null;
  }
}

/**
 * Try all RapidAPI keys for a list of symbols.
 */
async function fetchFromRapidApi(symbolsToTry, companyName) {
  const keys = getKeys("RAPIDAPI_KEY");
  if (keys.length === 0) {
    console.warn("[Finance] RapidAPI skipped — no RAPIDAPI_KEY env vars found");
    return null;
  }

  console.log(`[Finance] RapidAPI trying ${symbolsToTry.join(", ")} with ${keys.length} key(s)`);

  for (const symbol of symbolsToTry) {
    for (const key of keys) {
      const data = await fetchRapidApiQuote(symbol, key);
      if (data) return data;
    }
  }

  // Try searching by company name if direct symbol lookups all failed
  if (companyName) {
    const firstKey = keys[0];
    const found = await searchRapidApiSymbol(companyName, firstKey);
    if (found && !symbolsToTry.includes(found)) {
      console.log(`[Finance] RapidAPI search found: ${found}`);
      for (const key of keys) {
        const data = await fetchRapidApiQuote(found, key);
        if (data) return data;
      }
    }
  }

  console.warn(`[Finance] RapidAPI all attempts failed`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Polygon.io  (price-only fallback for US stocks — free tier)
//    Sign up free at: https://polygon.io/
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPolygonData(symbol, apiKey) {
  if (symbol.includes(".")) return null;
  try {
    const res = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev?adjusted=true&apiKey=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) {
      console.warn(`[Finance] Polygon HTTP ${res.status} for ${symbol}`);
      return null;
    }
    const json = await res.json();
    const bar = json?.results?.[0];
    const price = bar?.c ? Number(bar.c) : null;
    if (!price) return null;
    console.log(`[Finance] Polygon ✓ ${symbol} @ $${price}`);
    return {
      currentPrice: price,
      marketCap: null, peRatio: null, eps: null, revenue: null,
      netIncome: null, debtToEquity: null, profitMargin: null,
      week52High: null, week52Low: null, analystTargetPrice: null,
      revenueGrowth: null, currency: "USD",
      shortName: symbol, yahooSymbol: symbol, source: "polygon",
    };
  } catch (err) {
    console.warn(`[Finance] Polygon exception for ${symbol}: ${err.message}`);
    return null;
  }
}

async function fetchFromPolygon(symbol) {
  const keys = getKeys("POLYGON_API_KEY");
  if (keys.length === 0) {
    console.log("[Finance] Polygon skipped — no POLYGON_API_KEY env vars found");
    return null;
  }
  console.log(`[Finance] Polygon trying ${symbol} with ${keys.length} key(s)`);
  for (const key of keys) {
    const data = await fetchPolygonData(symbol, key);
    if (data) return data;
  }
  return null;
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
      shortName: symbol, yahooSymbol: symbol, source: "alphavantage",
    };
  } catch { return null; }
}

async function fetchFromAlphaVantage(symbol) {
  const keys = getKeys("ALPHA_VANTAGE_KEY");
  if (keys.length === 0) {
    console.log("[Finance] AlphaVantage skipped — no ALPHA_VANTAGE_KEY env vars found");
    return null;
  }
  console.log(`[Finance] AlphaVantage trying ${symbol} with ${keys.length} key(s)`);
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
// Resolve ticker from web when all direct lookups fail
// ─────────────────────────────────────────────────────────────────────────────

async function resolveSymbolViaWeb(companyName, exchange) {
  try {
    const hint = (exchange ?? "").toUpperCase().includes("NSE") ? "NSE" : "stock";
    const results = await searchTavily(
      `${companyName} ${hint} ticker symbol yahoo finance`, 5
    );
    const corpus = results.map((r) => `${r.title} ${r.snippet}`).join(" ");
    const dotted = corpus.match(/\b([A-Z][A-Z0-9]{1,11})\.(NS|BO|L|TO|AX)\b/);
    if (dotted) return `${dotted[1]}.${dotted[2]}`;
    const nse = corpus.match(/\b([A-Z][A-Z0-9]{1,11})\b(?=\s*(?:on NSE|NSE ticker|NSE:?))/i);
    if (nse) return `${nse[1].toUpperCase()}${hint === "NSE" ? ".NS" : ""}`;
    return null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch comprehensive financial data.
 * Priority: RapidAPI Yahoo Finance → Polygon.io → Alpha Vantage
 *
 * @param {string}      ticker
 * @param {string|null} exchange
 * @param {string|null} companyName
 * @returns {Promise<object|null>}
 */
export async function fetchFinancialData(ticker, exchange = null, companyName = null) {
  if (!ticker && !companyName) return null;

  let symbolsToTry = buildYahooSymbols(ticker, exchange);

  // Auto-add Indian suffixes for known Indian company names
  if (ticker && !ticker.includes(".") && companyName && INDIAN_NAME_RE.test(companyName)) {
    const upper = ticker.toUpperCase();
    if (!symbolsToTry.includes(`${upper}.NS`)) symbolsToTry.push(`${upper}.NS`);
    if (!symbolsToTry.includes(`${upper}.BO`)) symbolsToTry.push(`${upper}.BO`);
  }

  // ── 1. RapidAPI Yahoo Finance (primary — full data, no IP blocks) ──
  const rapidData = await fetchFromRapidApi(symbolsToTry, companyName);
  if (rapidData) return rapidData;

  // ── 2. Try resolving symbol from web then retry RapidAPI ──
  if (companyName) {
    const webSymbol = await resolveSymbolViaWeb(companyName, exchange);
    if (webSymbol && !symbolsToTry.includes(webSymbol)) {
      console.log(`[Finance] Resolved symbol via web: ${webSymbol}`);
      symbolsToTry.push(webSymbol);
      const rapidData2 = await fetchFromRapidApi([webSymbol], companyName);
      if (rapidData2) return rapidData2;
    }
  }

  // ── 3. Polygon.io (price-only, US stocks) ──
  const bareSymbol = symbolsToTry.find((s) => !s.includes("."));
  if (bareSymbol) {
    const polygonData = await fetchFromPolygon(bareSymbol);
    if (polygonData) return polygonData;
  }

  // ── 4. Alpha Vantage (last resort) ──
  for (const symbol of symbolsToTry) {
    const avData = await fetchFromAlphaVantage(symbol);
    if (avData) return avData;
  }

  console.error(
    `[Finance] All sources failed for "${ticker ?? companyName}" (tried: ${symbolsToTry.join(", ")})`
  );
  return null;
}
