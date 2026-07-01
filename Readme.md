# AI Investment Research Agent

## Overview

A full-stack app that automates equity research: type a company name, and a multi-step AI agent resolves the ticker, pulls live financial data, analyzes news sentiment, researches competitors, and produces an INVEST/PASS/WATCH verdict. The agent is a LangGraph state machine that streams its reasoning to the browser live over Server-Sent Events.

## 🔗 Live Demo

**[https://invest-seven-delta.vercel.app/](https://invest-seven-delta.vercel.app/)**

> Frontend hosted on Vercel · Backend hosted on Render

## How to Run It

### Prerequisites
- Node.js 20.x, npm
- Free API keys (no paid tier required)

### 1. Install

```bash
cd server && npm install
cd ../client && npm install
```

### 2. Configure environment

**`server/.env`** (from `server/.env.example`):

```bash
# LLM providers — at least one required, app is built for all three
GROQ_API_KEY=...          # console.groq.com — free
GOOGLE_API_KEY=...        # aistudio.google.com — free
CEREBRAS_API_KEY=...      # cloud.cerebras.ai — free

TAVILY_API_KEY=...        # web search — used for ticker/news/competitors

PORT=8000
CLIENT_URL=http://localhost:5173

# Financial data — at least one required
RAPIDAPI_KEY_1=...        # rapidapi.com/sparior/api/yahoo-finance15
POLYGON_API_KEY_1=...     # polygon.io — US equities, price-only
ALPHA_VANTAGE_KEY=...     # 25 req/day, last resort
```

Any key can be suffixed `_1`–`_4` to register multiple keys per provider as a fallback pool (see Trade-offs).

**`client/.env`** (from `client/.env.example`): `VITE_API_URL` plus four `VITE_APPWRITE_*` vars. Appwrite only backs optional login/watchlist features — the core agent runs without it.

### 3. Run

```bash
cd server && npm run dev   # Express + agent, http://localhost:8000
cd client && npm run dev   # Vite, http://localhost:5173
```

Open the app, enter a public company name, pick a risk appetite, submit. The agent's steps stream live; the final report renders with charts and a verdict card.

### Deployment

`vercel.json` (frontend) and `render.yaml` (backend) reflect the actual deployment: Vercel for the static frontend, Render for the Node backend, `CLIENT_URL`/`VITE_API_URL` cross-wired.

## How It Works

### Agent architecture

The agent is a LangGraph `StateGraph` (`server/src/agent/graph.js`) — eight nodes sharing one state object:

```
User enters company name
        │
        ▼
   React Client (client/)
        │  POST /api/research { companyName, riskAppetite }
        ▼
   Express Server (server/)
        │
        ▼
   LangGraph StateGraph (server/src/agent/graph.js)
        │
        ▼
   ticker_resolver
        │  Tavily search → fast LLM extracts { ticker, exchange }
        │
        ├──────────────┬──────────────┬──────────────────┐
        ▼              ▼              ▼                  ▼
  financial_data  news_sentiment  web_research   competitor_analysis
  (4-tier API     (Tavily +       (4 parallel     (Tavily +
   fallback)       fast LLM)       Tavily queries)  smart LLM)
        │              │              │                  │
        └──────────────┴──────────────┴──────────────────┘
                            │  all 4 results merged into shared state
                            ▼
                         analyst
                  (smart LLM synthesis →
                   executive summary,
                   positive/risk factors)
                            │
                            ▼
                         decision
                (smart LLM → verdict + confidence:
                   INVEST / PASS / WATCH)
                            │
                            ▼
                      report_builder
               (assembles 6 report sections)
                            │
                            ▼
              Final report streamed back to React UI
                     (via Server-Sent Events)
```

`ticker_resolver` runs first; the four research nodes then run **in parallel** since none depend on each other. Their outputs converge into `analyst` (synthesis), `decision` (verdict + confidence), and `report_builder` (assembles the six sections the UI renders). Every node emits progress events through a shared emitter and returns a partial state update merged by the reducers in `state.js`.

### Real-time streaming

The Express route opens an SSE connection per request and forwards events from the same `EventEmitter` passed into the graph's `configurable` context — no buffering or polling. The frontend's `useStreamParser` incrementally parses the chunked stream and `useResearch` drives the progress UI.

```
React Client                Express Route              LangGraph Agent           External APIs
     │                            │                            │                       │
     │  POST /api/research        │                            │                       │
     │ ─────────────────────────► │                            │                       │
     │                            │  res.write SSE headers      │                       │
     │ ◄───────────────────────── │                            │                       │
     │                            │  researchGraph.invoke()     │                       │
     │                            │ ─────────────────────────► │                       │
     │                            │                            │  Tavily / Groq /      │
     │                            │                            │  Gemini / RapidAPI /  │
     │                            │                            │  Polygon / AlphaVant. │
     │                            │                            │ ────────────────────► │
     │                            │                            │ ◄──────────────────── │
     │                            │  emitter.emit("event", …)   │                       │
     │                            │ ◄───────────────────────── │   (per node, repeated) │
     │  data: {type, node, msg}\n\n                             │                       │
     │ ◄───────────────────────── │                            │                       │
     │   (AgentProgress UI updates live, one event per step)    │                       │
     │                            │                            │                       │
     │                            │  final state returned       │                       │
     │                            │ ◄───────────────────────── │                       │
     │  data: {type:"final_report", verdict, reportSections…}\n\n│                       │
     │ ◄───────────────────────── │                            │                       │
     │  data: [DONE]\n\n          │                            │                       │
     │ ◄───────────────────────── │                            │                       │
     │      connection closed     │                            │                       │
```

### LLM routing (`lib/llm.js`)

Two provider chains: **fast** (Groq → Cerebras → Gemini, for low-latency steps) and **smart** (Gemini → Cerebras → Groq, for synthesis-heavy steps). Within each provider, up to five keys (`KEY`, `_1`...`_4`) are tried before falling back to the next provider — a two-level fallback built after repeatedly hitting free-tier rate limits in development.

Because every node prompts for raw JSON rather than using tool-calling, `lib/llm.js` also includes a multi-stage parser: direct `JSON.parse`, markdown-fence stripping, truncated-JSON repair, and regex field extraction as a last resort — needed because smaller open-weight models are less reliable at strict JSON than frontier models.

### Financial data fallback chain

`yahooFinance.js` tries, in order: RapidAPI Yahoo Finance → a web-search-assisted symbol re-resolution retry → Polygon.io (US, price-only) → Alpha Vantage (price-only, 25/day). Each tier degrades gracefully rather than failing outright. The git history shows this replaced three earlier single-provider designs after each hit paid-tier walls or IP blocking.

### File structure

The backend (`server/`) separates the agent (`src/agent/`) from infrastructure (`src/lib/`, `src/routes/`); the frontend (`client/`) separates SSE/state management (`context/`, `hooks/`) from presentation (`components/`).

```
AiInvestmentResearchAgent/
│
├── server/                          Express API + LangGraph agent
│   ├── src/
│   │   ├── index.js                 Express app, CORS, startup key checks
│   │   ├── routes/
│   │   │   └── research.js          POST /api/research, opens SSE stream
│   │   ├── agent/
│   │   │   ├── graph.js             StateGraph definition (8 nodes, edges)
│   │   │   ├── state.js             Shared state schema + reducers
│   │   │   ├── nodes/                ── one file per pipeline step ──
│   │   │   │   ├── tickerResolver.js
│   │   │   │   ├── financialData.js
│   │   │   │   ├── newsSentiment.js
│   │   │   │   ├── webResearch.js
│   │   │   │   ├── competitorAnalysis.js
│   │   │   │   ├── analyst.js
│   │   │   │   ├── decision.js
│   │   │   │   └── reportBuilder.js
│   │   │   └── tools/
│   │   │       ├── tavilySearch.js  Web search, multi-key fallback
│   │   │       └── yahooFinance.js  4-tier financial data fallback
│   │   └── lib/
│   │       ├── llm.js               Provider pools + JSON repair
│   │       ├── helpers.js           Retry, response parsing
│   │       └── streamEmitter.js     SSE event emitter
│   ├── .env / .env.example
│   └── render.yaml                  Render deployment config
│
└── client/                          Vite + React SPA
    ├── src/
    │   ├── App.jsx                  Routes: Home, Login, Watchlist, Settings
    │   ├── context/
    │   │   ├── ResearchContext.jsx  SSE connection + accumulated state
    │   │   └── AuthContext.jsx      Appwrite auth
    │   ├── hooks/
    │   │   ├── useResearch.js
    │   │   ├── useStreamParser.js   Parses chunked SSE text into events
    │   │   └── useWatchlist.js
    │   ├── components/
    │   │   ├── AgentProgress.jsx    Live step-by-step progress UI
    │   │   ├── VerdictCard.jsx
    │   │   ├── SentimentGauge.jsx
    │   │   └── ...                  charts, report sections
    │   ├── pages/
    │   │   └── Home.jsx / Login.jsx / Watchlist.jsx / Settings.jsx
    │   └── lib/
    │       └── appwrite.js          Auth + watchlist client
    ├── .env / .env.example
    └── vercel.json                  Vercel deployment config
```

## Key Decisions & Trade-offs

- **LangGraph over a hand-rolled pipeline.** Explicit edges document data-flow dependencies and let four research nodes run concurrently. Costs a small amount of boilerplate (state reducers) for a graph that's still mostly linear today, but leaves room for conditional routing later.
- **Three free-tier LLM providers instead of one paid API.** Keeps the project runnable at zero cost, but smaller open-weight models are less reliable at strict JSON — most of the parsing-recovery code exists specifically to compensate for this.
- **Four-tier financial data fallback instead of one source.** Free financial APIs are inconsistent (IP blocks, paid-tier walls, tiny quotas), so the app degrades to *some* usable snapshot for almost any ticker rather than failing. Trade-off: data completeness varies — a major US stock gets full fundamentals, an obscure one might only get a price.
- **No persistent database for results.** Every run is computed fresh; nothing is cached server-side. Appwrite is used only for accounts/watchlist, not for caching agent output. Simpler, but means repeat queries re-spend API quota.
- **No automated test suite.** Given heavy reliance on rate-limited third-party APIs, I prioritized manual verification against live APIs during development over a mock-based suite. This is a known gap (see below), not an oversight.
- **SSE over WebSockets.** Simpler for one-directional server-to-client streaming over plain HTTP. Trade-off: no way to interrupt or redirect an in-progress run from the client.

## Example Runs

1. **"Apple" (well-covered US large-cap).** Ticker resolver correctly finds `AAPL`/NASDAQ via search. Financial data succeeds on the first fallback tier with a full dataset. All four research nodes return rich results, and the analyst produces a confident, high-data-quality verdict — the happy path where no fallback tier is needed.
2. **"Tata Motors" / "Zomato" (Indian NSE listing).** Exercises exchange-suffix handling: `.NS`/`.BO` suffixes get added based on the resolved exchange, with a name-based regex as a backstop. The ticker prompt explicitly handles the Zomato→ETERNAL rebrand as a worked example, since a naive lookup would return the old ticker.
3. **An obscure or thinly-covered company.** Ticker resolution may still succeed, but financial data is more likely to descend through multiple fallback tiers, possibly landing on a bare price from Alpha Vantage. The analyst is told to treat missing data as `"Financial data unavailable"`, and the decision node is explicitly biased toward WATCH rather than a false-confidence verdict — the graceful-degradation path the fallback chain exists for.

## What You Would Improve With More Time

- Unit-test the pure, dependency-free logic first: JSON-recovery functions in `lib/llm.js` and symbol-building in `yahooFinance.js`.
- Cache financial/search results briefly to stretch tight free-tier quotas (RapidAPI: 500/mo, Alpha Vantage: 25/day).
- Replace prompt-for-raw-JSON with native structured output / tool calling, eliminating most parsing-recovery code.
- Add conditional graph routing — e.g. skip competitor analysis when no competitors surface, or short-circuit to WATCH on ticker-resolution failure.
- Render report sections progressively as each node completes, instead of waiting for `final_report`.
- Persist completed reports so users can track a company's verdict over time, not just save it to a watchlist.
- Normalize the financial-data shape across fallback tiers so the analyst (and a human reviewer) can see exactly which fields are real vs. missing, instead of inferring it from scattered `null` checks.