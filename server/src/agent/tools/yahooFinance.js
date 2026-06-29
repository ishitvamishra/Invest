import YahooFinance from "yahoo-finance2";
import { searchTavily } from "./tavilySearch.js";

// ─────────────────────────────────────────────────────────────────────────────
// Financial Modeling Prep  (PRIMARY — works on all cloud IPs, 250 req/day free)
// Sign up free at: https://financialmodelingprep.com/developer/docs/
// ─────────────────────────────────────────────────────────────────────────────

function getFmpKeys() {
  const keys = ["", "_1", "_2", "_3", "_4"]
    .map((s) => process.env[`FMP_API_KEY${s}`]?.trim())
    .filter((k) => k && !k.startsWith("your_"));
  return [...new Set(keys)];
}

/**
 * Fetch a full quote + profile from FMP for a given ticker.
 * Uses /v3/quote/:symbol and /v3/profile/:symbol endpoints.
 * @param {string} symbol
 * @param {string} apiKey
 * @returns {Promise<object|null>}
 */
async function fetchFmpQuote(symbol, apiKey) {
  try {
    const [quoteRes, profileRes] = await Promise.all([
      fetch(
        `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(symbol)}?apikey=${apiKey}`,
        { signal: AbortSignal.timeout(10000) }
      ),
      fetch(
        `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(symbol)}?apikey=${apiKey}`,
        { signal: AbortSignal.timeout(10000) }
      ),
    ]);

    if (!quoteRes.ok) {
      console.warn(`[Finance] FMP HTTP ${quoteRes.status} for ${symbol}`);
      return null;
    }

    const quoteJson = await quoteRes.json();
    const profileJson = profileRes.ok ? await profileRes.json() : [];

    // FMP returns an array; check for error objects
    if (!Array.isArray(quoteJson) || quoteJson.length === 0) {
      // FMP returns {"Error Message": "..."} or {"message":"..."} on failure
      const msg = quoteJson?.["Error Message"] ?? quoteJson?.message ?? "";
      if (msg) console.warn(`[Finance] FMP error for ${symbol}: ${msg.slice(0, 120)}`);
      else console.warn(`[Finance] FMP empty response for ${symbol}`);
      return null;
    }

    const q = quoteJson[0];
    const p = Array.isArray(profileJson) && profileJson.length > 0 ? profileJson[0] : {};

    const safeNum = (v) =>
      v !== undefined && v !== null && !Number.isNaN(Number(v)) ? Number(v) : null;

    const currentPrice = safeNum(q.price);
    const marketCap = safeNum(q.marketCap ?? p.mktCap);

    if (!currentPrice) {
      console.warn(`[Finance] FMP no price for ${symbol}`);
      return null;
    }

    // Detect currency from exchange/symbol suffix
    const isIndian = symbol.endsWith(".NS") || symbol.endsWith(".BO") ||
      (p.exchangeShortName ?? "").match(/NSE|BSE/i);
    const currency = p.currency ?? (isIndian ? "INR" : "USD");

    console.log(`[Finance] FMP ✓ ${symbol} @ ${currency} ${currentPrice}`);

    return {
      currentPrice,
      marketCap,
      peRatio: safeNum(q.pe ?? p.pe),
      eps: safeNum(q.eps),
      revenue: safeNum(p.revenue),
      netIncome: safeNum(
        p.netIncomeRatio != null && p.revenue != null
          ? p.revenue * p.netIncomeRatio
          : null
      ),
      debtToEquity: safeNum(p.debtToEquity),
      profitMargin: safeNum(p.netIncomeRatio),
      week52High: safeNum(q.yearHigh),
      week52Low: safeNum(q.yearLow),
      analystTargetPrice: safeNum(q.priceAvg50 ?? null), // FMP doesn't give analyst target on free tier
      revenueGrowth: null, // not on free endpoint
      currency,
      shortName: p.companyName ?? q.name ?? symbol,
      yahooSymbol: symbol,
      source: "fmp",
    };
  } catch (err) {
    console.warn(`[Finance] FMP exception for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * Search FMP for a ticker by company name.
 * @param {string} companyName
 * @param {string} apiKey
 * @returns {Promise<string|null>}
 */
async function searchFmpSymbol(companyName, apiKey) {
  try {
    const res = await fetch(
      `https://financialmodelingprep.com/api/v3/search?query=${encodeURIComponent(companyName)}&limit=10&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;

    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return null;

    const nameLower = companyName.toLowerCase();

    // Prefer exact name match, then NSE/BSE listed, then first result
    const exact = results.find((r) =>
      (r.name ?? "").toLowerCase().includes(nameLower) ||
      nameLower.includes((r.name ?? "").toLowerCase().split(" ")[0])
    );
    const indian = results.find(
      (r) => r.exchangeShortName === "NSE" || r.exchangeShortName === "BSE"
    );
    const best = exact ?? indian ?? results[0];

    return best?.symbol ?? null;
  } catch {
    return null;
  }
}

/**
 * Try every FMP key in the pool for a symbol, then search by name as fallback.
 * @param {string|null} ticker
 * @param {string|null} companyName
 * @param {string[]} symbolsToTry
 * @returns {Promise<object|null>}
 */
async function fetchFromFmp(ticker, companyName, symbolsToTry) {
  const keys = getFmpKeys();
  if (keys.length === 0) {
    console.warn("[Finance] FMP skipped — no FMP_API_KEY env vars found");
    return null;
  }

  console.log(`[Finance] FMP trying ${symbolsToTry.join(", ")} with ${keys.length} key(s)`);

  // Try each symbol with each key
  for (const symbol of symbolsToTry) {
    for (const key of keys) {
      const data = await fetchFmpQuote(symbol, key);
      if (data) return data;
    }
  }

  // Try searching by company name with first key
  if (companyName) {
    const found = await searchFmpSymbol(companyName, keys[0]);
    if (found && !symbolsToTry.includes(found)) {
      console.log(`[Finance] FMP search found symbol: ${found}`);
      for (const key of keys) {
        const data = await fetchFmpQuote(found, key);
        if (data) return data;
      }
    }
  }

  console.warn(`[Finance] FMP all attempts failed for ${ticker ?? companyName}`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alpha Vantage  (SECONDARY fallback — 25 req/day free per key)
// ─────────────────────────────────────────────────────────────────────────────

function getAlphaVantageKeys() {
  const keys = ["", "_1", "_2", "_3", "_4"]
    .map((s) => process.env[`ALPHA_VANTAGE_KEY${s}`]?.trim())
    .filter((k) => k && !k.startsWith("your_") && k !== "demo");
  return [...new Set(keys)];
}

async function fetchAlphaVantageQuote(symbol, apiKey) {
  try {
    const url =
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE` +
      `&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;

    const json = await res.json();
    if (json["Note"] || json["Information"]) {
      console.warn(`[Finance] AV rate-limited for ${symbol}`);
      return null;
    }
    if (json["Error Message"]) return null;

    const q = json["Global Quote"];
    if (!q || !q["05. price"]) return null;

    const price = parseFloat(q["05. price"]);
    if (!price) return null;

    return {
      currentPrice: price,
      marketCap: null,
      peRatio: null,
      eps: null,
      revenue: null,
      netIncome: null,
      debtToEquity: null,
      profitMargin: null,
      week52High: parseFloat(q["03. high"]) || null,
      week52Low: parseFloat(q["04. low"]) || null,
      analystTargetPrice: null,
      revenueGrowth: null,
      currency: symbol.endsWith(".NS") || symbol.endsWith(".BO") ? "INR" : "USD",
      shortName: symbol,
      yahooSymbol: symbol,
      source: "alphavantage",
    };
  } catch {
    return null;
  }
}

async function fetchFromAlphaVantage(symbol) {
  const keys = getAlphaVantageKeys();
  if (keys.length === 0) return null;

  for (const key of keys) {
    const data = await fetchAlphaVantageQuote(symbol, key);
    if (data) {
      console.log(`[Finance] AV ✓ ${symbol} @ ${data.currentPrice}`);
      return data;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Yahoo Finance  (LOCAL fallback — blocked on most cloud IPs)
// ─────────────────────────────────────────────────────────────────────────────

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  fetchOptions: {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
  },
});

async function fetchQuoteSummary(symbol) {
  try {
    const summary = await yahooFinance.quoteSummary(
      symbol,
      { modules: ["price", "summaryDetail", "financialData", "defaultKeyStatistics"] },
      { validateResult: false }
    );

    const price = summary.price ?? {};
    const summaryDetail = summary.summaryDetail ?? {};
    const financialData = summary.financialData ?? {};
    const keyStats = summary.defaultKeyStatistics ?? {};

    const safeNum = (v) =>
      v !== undefined && v !== null && !Number.isNaN(Number(v)) ? Number(v) : null;

    const currentPrice = safeNum(price.regularMarketPrice);
    const marketCap = safeNum(price.marketCap ?? summaryDetail.marketCap);
    if (!currentPrice && !marketCap) return null;

    console.log(`[Finance] Yahoo ✓ ${symbol} @ ${currentPrice}`);
    return {
      currentPrice,
      marketCap,
      peRatio: safeNum(summaryDetail.trailingPE ?? keyStats.trailingPE),
      eps: safeNum(keyStats.trailingEps),
      revenue: safeNum(financialData.totalRevenue),
      netIncome: safeNum(
        financialData.profitMargins && financialData.totalRevenue
          ? financialData.totalRevenue * financialData.profitMargins
          : null
      ),
      debtToEquity: safeNum(financialData.debtToEquity),
      profitMargin: safeNum(financialData.profitMargins),
      week52High: safeNum(summaryDetail.fiftyTwoWeekHigh),
      week52Low: safeNum(summaryDetail.fiftyTwoWeekLow),
      analystTargetPrice: safeNum(financialData.targetMeanPrice),
      revenueGrowth: safeNum(financialData.revenueGrowth),
      currency: price.currency ?? "USD",
      shortName: price.shortName ?? price.longName ?? symbol,
      yahooSymbol: symbol,
      source: "yahoo",
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol helpers
// ─────────────────────────────────────────────────────────────────────────────

const EXCHANGE_SUFFIX = {
  NSE: ".NS", BSE: ".BO", LSE: ".L", LON: ".L",
  TSE: ".T", HKEX: ".HK", ASX: ".AX", TSX: ".TO",
  FRA: ".F", XETRA: ".DE",
};

const INDIAN_COMPANY_RE =
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

  const isIndianHint =
    exchangeKey.match(/NSE|BSE|INDIA|BOMBAY/) != null;

  if (isIndianHint) {
    symbols.add(`${upper}.NS`);
    symbols.add(`${upper}.BO`);
  }

  return [...symbols];
}

async function resolveSymbolViaWeb(companyName, exchange = null) {
  try {
    const hint = (exchange ?? "").toUpperCase().includes("NSE") ? "NSE" : "stock";
    const results = await searchTavily(
      `${companyName} ${hint} ticker symbol exchange`,
      5
    );
    const corpus = results.map((r) => `${r.title} ${r.snippet}`).join("\n");

    const dotted = corpus.match(/\b([A-Z][A-Z0-9]{1,11})\.(NS|BO|L|TO|AX)\b/);
    if (dotted) return `${dotted[1]}.${dotted[2]}`;

    const nse = corpus.match(/\b([A-Z][A-Z0-9]{1,11})\b(?=\s*(?:on NSE|NSE ticker|NSE:?))/i);
    if (nse) return `${nse[1].toUpperCase()}${hint === "NSE" ? ".NS" : ""}`;

    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch comprehensive financial data.
 * Priority: FMP → Yahoo Finance → Alpha Vantage
 *
 * @param {string}      ticker
 * @param {string|null} exchange
 * @param {string|null} companyName
 * @returns {Promise<object|null>}
 */
export async function fetchFinancialData(ticker, exchange = null, companyName = null) {
  if (!ticker && !companyName) return null;

  // Build the list of symbols to try (bare + exchange-suffixed variants)
  let symbolsToTry = buildYahooSymbols(ticker, exchange);

  // Auto-add Indian suffixes when the company name looks Indian
  if (ticker && !ticker.includes(".") && companyName && INDIAN_COMPANY_RE.test(companyName)) {
    const upper = ticker.toUpperCase();
    if (!symbolsToTry.includes(`${upper}.NS`)) symbolsToTry.push(`${upper}.NS`);
    if (!symbolsToTry.includes(`${upper}.BO`)) symbolsToTry.push(`${upper}.BO`);
  }

  // ── 1. Financial Modeling Prep (primary — no IP blocks, rich data) ──
  const fmpData = await fetchFromFmp(ticker, companyName, symbolsToTry);
  if (fmpData) return fmpData;

  // ── 2. Yahoo Finance (works locally; blocked on most cloud IPs) ──
  for (const symbol of symbolsToTry) {
    const data = await fetchQuoteSummary(symbol);
    if (data) return data;
  }

  // ── 3. Resolve symbol from web then retry FMP + Yahoo ──
  if (companyName) {
    const webSymbol = await resolveSymbolViaWeb(companyName, exchange);
    if (webSymbol && !symbolsToTry.includes(webSymbol)) {
      const fmpData2 = await fetchFromFmp(ticker, companyName, [webSymbol]);
      if (fmpData2) return fmpData2;

      const yahooData = await fetchQuoteSummary(webSymbol);
      if (yahooData) return yahooData;
    }
  }

  // ── 4. Alpha Vantage (last resort — 25 req/day) ──
  for (const symbol of symbolsToTry) {
    const avData = await fetchFromAlphaVantage(symbol);
    if (avData) return avData;
  }

  console.error(
    `[Finance] All sources failed for "${ticker ?? companyName}" (tried: ${symbolsToTry.join(", ")})`
  );
  return null;
}
