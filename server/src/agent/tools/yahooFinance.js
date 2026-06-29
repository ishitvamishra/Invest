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

  const isIndianHint =
    exchangeKey.includes("NSE") ||
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
 * Strategy: Yahoo Finance first (no rate limits) → Alpha Vantage fallback
 * @param {string} ticker
 * @param {string|null} exchange
 * @param {string|null} companyName
 * @returns {Promise<object|null>}
 */
export async function fetchFinancialData(ticker, exchange = null, companyName = null) {
  if (!ticker && !companyName) return null;

  const symbolsToTry = buildYahooSymbols(ticker, exchange);

  // ── 1. Try Yahoo Finance first (no rate limits, rich data) ──
  for (const symbol of symbolsToTry) {
    const data = await fetchQuoteSummary(symbol);
    if (data) return data;
  }

  // ── 2. If ticker looks Indian and no suffix tried yet, force .NS / .BO ──
  const isLikelyIndian = !ticker?.includes(".") && (
    (exchange ?? "").toUpperCase().match(/NSE|BSE|INDIA|BOMBAY/) ||
    // Heuristic: all-caps Indian names without exchange hint
    companyName?.match(/reliance|tata|infosys|wipro|hdfc|icici|bajaj|adani|airtel/i)
  );

  if (isLikelyIndian) {
    const upper = (ticker ?? "").toUpperCase();
    for (const suffix of [".NS", ".BO"]) {
      const sym = `${upper}${suffix}`;
      if (!symbolsToTry.includes(sym)) {
        const data = await fetchQuoteSummary(sym);
        if (data) return data;
      }
    }
  }

  // ── 3. Yahoo search by company name ──
  if (companyName) {
    const searchedSymbol = await searchYahooSymbol(companyName, exchange);
    if (searchedSymbol) {
      const data = await fetchQuoteSummary(searchedSymbol);
      if (data) return data;

      // Also try Alpha Vantage with the searched symbol
      const avData = await fetchFromAlphaVantage(searchedSymbol);
      if (avData) return avData;
    }

    const webSymbol = await resolveSymbolViaWeb(companyName, exchange);
    if (webSymbol) {
      const data = await fetchQuoteSummary(webSymbol);
      if (data) return data;

      const avData = await fetchFromAlphaVantage(webSymbol);
      if (avData) return avData;
    }
  }

  // ── 4. Last resort: Alpha Vantage (rate-limited, but better than nothing) ──
  const primarySymbol = symbolsToTry[0];
  if (primarySymbol) {
    const avData = await fetchFromAlphaVantage(primarySymbol);
    if (avData) return avData;

    for (const sym of symbolsToTry.slice(1)) {
      const avData2 = await fetchFromAlphaVantage(sym);
      if (avData2) return avData2;
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

    console.log(`[Finance] Yahoo ✓ ${symbol} @ ${price.currency ?? ""}${currentPrice}`);
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
  } catch (err) {
    console.warn(`[Finance] Yahoo quoteSummary failed for ${symbol}: ${err.message?.slice(0, 100)}`);
    // Try raw fetch fallback
    return fetchYahooRaw(symbol);
  }
}

/**
 * Raw fetch fallback — hits Yahoo Finance v8 chart API directly.
 * Works even when the yahoo-finance2 lib is blocked by IP.
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
async function fetchYahooRaw(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://finance.yahoo.com/",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;

    console.log(`[Finance] Yahoo raw ✓ ${symbol} @ ${meta.currency ?? ""}${meta.regularMarketPrice}`);
    return {
      currentPrice: meta.regularMarketPrice ?? null,
      marketCap: meta.marketCap ?? null,
      peRatio: null,
      eps: null,
      revenue: null,
      netIncome: null,
      debtToEquity: null,
      profitMargin: null,
      week52High: meta.fiftyTwoWeekHigh ?? null,
      week52Low: meta.fiftyTwoWeekLow ?? null,
      analystTargetPrice: null,
      revenueGrowth: null,
      currency: meta.currency ?? "USD",
      shortName: meta.shortName ?? meta.longName ?? symbol,
      yahooSymbol: symbol,
      source: "yahoo_raw",
    };
  } catch (err) {
    console.warn(`[Finance] Yahoo raw failed for ${symbol}: ${err.message?.slice(0, 80)}`);
    return null;
  }
}
