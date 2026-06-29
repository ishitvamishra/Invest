import YahooFinance from "yahoo-finance2";
import { searchTavily } from "./tavilySearch.js";

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

  if (upper.includes(".")) {
    return [...symbols];
  }

  const exchangeKey = (exchange ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

  for (const [key, suffix] of Object.entries(EXCHANGE_SUFFIX)) {
    if (exchangeKey.includes(key)) {
      symbols.add(`${upper}${suffix}`);
    }
  }

  symbols.add(`${upper}.NS`);
  symbols.add(`${upper}.BO`);

  return [...symbols];
}

/**
 * Fetch comprehensive financial data for a ticker symbol.
 * @param {string} ticker
 * @param {string|null} exchange
 * @returns {Promise<object|null>}
 */
export async function fetchFinancialData(ticker, exchange = null, companyName = null) {
  if (!ticker && !companyName) return null;

  const symbolsToTry = buildYahooSymbols(ticker, exchange);

  for (const symbol of symbolsToTry) {
    const data = await fetchQuoteSummary(symbol);
    if (data) return data;
  }

  if (companyName) {
    const searchedSymbol = await searchYahooSymbol(companyName, exchange);
    if (searchedSymbol) {
      const data = await fetchQuoteSummary(searchedSymbol);
      if (data) return data;
    }

    const webSymbol = await resolveSymbolViaWeb(companyName, exchange);
    if (webSymbol) {
      const data = await fetchQuoteSummary(webSymbol);
      if (data) return data;
    }
  }

  console.error(
    `Yahoo Finance fetch failed for "${ticker ?? companyName}" (tried: ${symbolsToTry.join(", ")})`
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
    };
  } catch {
    return null;
  }
}
