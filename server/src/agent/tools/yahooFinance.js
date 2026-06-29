import YahooFinance from "yahoo-finance2";
import { searchTavily } from "./tavilySearch.js";

// ── Alpha Vantage (primary — cloud-safe) ──────────────────────────────────

/**
 * Read a pool of up to 5 Alpha Vantage keys from env.
 * Reads: ALPHA_VANTAGE_KEY, ALPHA_VANTAGE_KEY_1 … ALPHA_VANTAGE_KEY_4
 * @returns {string[]}
 */
function getAlphaVantageKeys() {
  const keys = ["", "_1", "_2", "_3", "_4"]
    .map((s) => process.env[`ALPHA_VANTAGE_KEY${s}`]?.trim())
    .filter((k) => k && !k.startsWith("your_") && k !== "demo");
  return [...new Set(keys)];
}

/**
 * Fetch a stock quote from Alpha Vantage GLOBAL_QUOTE endpoint.
 * Returns structured data on success, null on failure.
 * @param {string} symbol   Exact ticker (e.g. "NVDA", "RELIANCE.NS")
 * @param {string} apiKey
 * @returns {Promise<object|null>}
 */
async function fetchAlphaVantageQuote(symbol, apiKey) {
  try {
    const url =
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE` +
      `&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;

    console.log(`[Finance] AV → fetching ${symbol}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!res.ok) {
      console.warn(`[Finance] AV HTTP ${res.status} for ${symbol}`);
      return null;
    }

    const json = await res.json();

    // Rate-limited or bad key — log the actual message so it shows in Render logs
    if (json["Note"]) {
      console.warn(`[Finance] AV rate-limited: ${json["Note"].slice(0, 120)}`);
      return null;
    }
    if (json["Information"]) {
      console.warn(`[Finance] AV info/limit: ${json["Information"].slice(0, 120)}`);
      return null;
    }
    if (json["Error Message"]) {
      console.warn(`[Finance] AV error: ${json["Error Message"].slice(0, 120)}`);
      return null;
    }

    const q = json["Global Quote"];
    if (!q || !q["05. price"]) {
      console.warn(`[Finance] AV empty response for ${symbol}:`, JSON.stringify(json).slice(0, 200));
      return null;
    }

    const price = parseFloat(q["05. price"]);
    if (!price) {
      console.warn(`[Finance] AV price=0 for ${symbol}`);
      return null;
    }

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
  } catch (err) {
    console.warn(`[Finance] AV exception for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Try every Alpha Vantage key in the pool for a given symbol.
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
async function fetchFromAlphaVantage(symbol) {
  const keys = getAlphaVantageKeys();
  if (keys.length === 0) {
    console.warn(`[Finance] AV skipped — no ALPHA_VANTAGE_KEY env vars found`);
    return null;
  }

  console.log(`[Finance] AV trying ${symbol} with ${keys.length} key(s)`);
  for (const key of keys) {
    const data = await fetchAlphaVantageQuote(symbol, key);
    if (data) {
      console.log(`[Finance] AV ✓ ${symbol} @ $${data.currentPrice}`);
      return data;
    }
  }
  console.warn(`[Finance] AV all ${keys.length} key(s) failed for ${symbol}`);
  return null;
}

// ── Yahoo Finance (fallback — may be blocked on cloud IPs) ────────────────

// Yahoo Finance blocks cloud provider IPs — spoof browser headers to bypass
const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  fetchOptions: {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
  },
});

const EXCHANGE_SUFFIX = {
  NSE: ".NS",
  BSE: ".BO",
  LSE: ".L",
  LON: ".L",
  TSE: ".T",
  HKEX: ".HK",
  SSE: ".SS",
  SZSE: ".SZ",
  ASX: ".AX",
  TSX: ".TO",
  FRA: ".F",
  XETRA: ".DE",
};

/**
 * Build Yahoo Finance symbol variants to try.
 * @param {string} ticker
 * @param {string|null} exchange
 * @returns {string[]}
 */
export function buildYahooSymbols(ticker, exchange = null) {
  if (!ticker) return [];

  const symbols = new Set();
  const upper = ticker.toUpperCase();

  symbols.add(upper);

  // If the ticker already has an exchange suffix, use it as-is
  if (upper.includes(".")) {
    return [...symbols];
  }

  const exchangeKey = (exchange ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

  // Add exchange-specific suffix if hint matches a known exchange
  for (const [key, suffix] of Object.entries(EXCHANGE_SUFFIX)) {
    if (exchangeKey.includes(key)) {
      symbols.add(`${upper}${suffix}`);
    }
  }

  // Only add Indian suffixes (.NS/.BO) when there is an Indian exchange hint.
  // Adding them unconditionally causes US tickers (AAPL, AMZN, etc.) to fail
  // every variant because Yahoo Finance has no AAPL.NS or AAPL.BO listing.
  const isIndianHint = exchangeKey.includes("NSE") ||
    exchangeKey.includes("BSE") ||
    exchangeKey.includes("INDIA") ||
    exchangeKey.includes("BOMBAY");

  if (isIndianHint) {
    symbols.add(`${upper}.NS`);
    symbols.add(`${upper}.BO`);
  }

  return [...symbols];
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch comprehensive financial data for a ticker symbol.
 * Strategy: Alpha Vantage (cloud-safe) → Yahoo Finance (may be blocked on cloud)
 * @param {string} ticker
 * @param {string|null} exchange
 * @param {string|null} companyName
 * @returns {Promise<object|null>}
 */
export async function fetchFinancialData(ticker, exchange = null, companyName = null) {
  if (!ticker && !companyName) return null;

  const symbolsToTry = buildYahooSymbols(ticker, exchange);
  const primarySymbol = symbolsToTry[0]; // bare ticker like "NVDA"

  // ── 1. Try Alpha Vantage first (reliable on cloud servers) ──
  if (primarySymbol) {
    const avData = await fetchFromAlphaVantage(primarySymbol);
    if (avData) return avData;

    // For Indian stocks also try with exchange suffix
    if (symbolsToTry.length > 1) {
      for (const sym of symbolsToTry.slice(1)) {
        const avData2 = await fetchFromAlphaVantage(sym);
        if (avData2) return avData2;
      }
    }
  }

  // ── 2. Fall back to Yahoo Finance (works locally; may be blocked in cloud) ──
  for (const symbol of symbolsToTry) {
    const data = await fetchQuoteSummary(symbol);
    if (data) return data;
  }

  if (companyName) {
    const searchedSymbol = await searchYahooSymbol(companyName, exchange);
    if (searchedSymbol) {
      // Try AV with searched symbol first
      const avData = await fetchFromAlphaVantage(searchedSymbol);
      if (avData) return avData;

      const data = await fetchQuoteSummary(searchedSymbol);
      if (data) return data;
    }

    const webSymbol = await resolveSymbolViaWeb(companyName, exchange);
    if (webSymbol) {
      const avData = await fetchFromAlphaVantage(webSymbol);
      if (avData) return avData;

      const data = await fetchQuoteSummary(webSymbol);
      if (data) return data;
    }
  }

  console.error(
    `[Finance] All sources failed for "${ticker ?? companyName}" (tried: ${symbolsToTry.join(", ")})`
  );
  return null;
}

/**
 * Search Yahoo Finance for the best matching symbol.
 * @param {string} companyName
 * @param {string|null} exchange
 * @returns {Promise<string|null>}
 */
async function searchYahooSymbol(companyName, exchange = null) {
  try {
    const region = (exchange ?? "").toUpperCase().includes("NSE") ? "IN" : "US";
    const titleName = companyName.trim();
    const capitalized =
      titleName.charAt(0).toUpperCase() + titleName.slice(1).toLowerCase();

    const queries = [
      titleName,
      `${titleName} stock`,
      `${capitalized} Limited`,
      `${titleName} NSE`,
    ];

    const seen = new Set();
    const equities = [];

    for (const query of queries) {
      const results = await yahooFinance.search(
        query,
        { quotesCount: 8, newsCount: 0, region },
        { validateResult: false }
      );

      for (const quote of results?.quotes ?? []) {
        if (!quote.symbol) continue;
        if (quote.isYahooFinance === false) continue;
        if (quote.quoteType && quote.quoteType !== "EQUITY") continue;
        if (seen.has(quote.symbol)) continue;
        seen.add(quote.symbol);
        equities.push(quote);
      }
    }

    if (equities.length === 0) return null;

    const nameLower = titleName.toLowerCase();
    const exact = equities.find((q) => {
      const short = (q.shortname ?? "").toLowerCase();
      const long = (q.longname ?? "").toLowerCase();
      const symbol = (q.symbol ?? "").toLowerCase();
      return (
        short.includes(nameLower) ||
        long.includes(nameLower) ||
        nameLower.includes(short.split(" ")[0]) ||
        symbol.startsWith(nameLower.slice(0, 4))
      );
    });

    const preferred =
      exact ??
      equities.find((q) => (q.symbol ?? "").endsWith(".NS")) ??
      equities[0];

    return preferred.symbol ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve Yahoo symbol from web search snippets when direct lookup fails.
 * @param {string} companyName
 * @param {string|null} exchange
 * @returns {Promise<string|null>}
 */
async function resolveSymbolViaWeb(companyName, exchange = null) {
  try {
    const exchangeHint = (exchange ?? "").toUpperCase().includes("NSE")
      ? "NSE"
      : (exchange ?? "stock");
    const results = await searchTavily(
      `${companyName} ${exchangeHint} stock ticker symbol yahoo finance`,
      5
    );

    const corpus = results.map((r) => `${r.title} ${r.snippet}`).join("\n");

    const dotted = corpus.match(/\b([A-Z][A-Z0-9]{1,11})\.(NS|BO|L|TO|AX)\b/);
    if (dotted) return `${dotted[1]}.${dotted[2]}`;

    const nse = corpus.match(/\b([A-Z][A-Z0-9]{1,11})\b(?=\s*(?:on NSE|NSE ticker|NSE:?))/i);
    if (nse) {
      const sym = nse[1].toUpperCase();
      return exchangeHint === "NSE" ? `${sym}.NS` : sym;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch via Yahoo Finance quoteSummary (may fail on cloud IPs).
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
async function fetchQuoteSummary(symbol) {
  try {
    const summary = await yahooFinance.quoteSummary(
      symbol,
      {
        modules: [
          "price",
          "summaryDetail",
          "financialData",
          "defaultKeyStatistics",
          "earnings",
        ],
      },
      { validateResult: false }
    );

    const price = summary.price ?? {};
    const summaryDetail = summary.summaryDetail ?? {};
    const financialData = summary.financialData ?? {};
    const keyStats = summary.defaultKeyStatistics ?? {};
    const earnings = summary.earnings ?? {};

    const safeNum = (val) =>
      val !== undefined && val !== null && !Number.isNaN(Number(val))
        ? Number(val)
        : null;

    const currentPrice = safeNum(price.regularMarketPrice ?? price.postMarketPrice);
    const marketCap = safeNum(price.marketCap ?? summaryDetail.marketCap);

    if (currentPrice === null && marketCap === null) {
      return null;
    }

    return {
      currentPrice,
      marketCap,
      peRatio: safeNum(summaryDetail.trailingPE ?? keyStats.trailingPE),
      eps: safeNum(keyStats.trailingEps ?? earnings.trailingEps),
      revenue: safeNum(financialData.totalRevenue),
      netIncome: safeNum(
        financialData.profitMargins != null && financialData.totalRevenue != null
          ? financialData.totalRevenue * financialData.profitMargins
          : null
      ),
      debtToEquity: safeNum(financialData.debtToEquity),
      profitMargin: safeNum(financialData.profitMargins),
      week52High: safeNum(summaryDetail.fiftyTwoWeekHigh),
      week52Low: safeNum(summaryDetail.fiftyTwoWeekLow),
      analystTargetPrice: safeNum(
        financialData.targetMeanPrice ?? summaryDetail.targetMeanPrice
      ),
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
