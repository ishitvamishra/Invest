import "dotenv/config";
import express from "express";
import cors from "cors";
import researchRouter from "./routes/research.js";
import { validateApiKeys } from "./lib/llm.js";

validateApiKeys();

// Check that at least one key exists for each provider (supports _1/_2/... naming)
const providerChecks = [
  { name: "GROQ_API_KEY",      suffixes: ["", "_1", "_2", "_3", "_4"] },
  { name: "GOOGLE_API_KEY",    suffixes: ["", "_1", "_2", "_3", "_4"] },
  { name: "CEREBRAS_API_KEY",  suffixes: ["", "_1", "_2", "_3", "_4"] },
  { name: "TAVILY_API_KEY",    suffixes: ["", "_1", "_2", "_3", "_4"] },
];
const missingProviders = providerChecks
  .filter(({ name, suffixes }) =>
    !suffixes.some((s) => process.env[`${name}${s}`]?.trim())
  )
  .map(({ name }) => name);
if (missingProviders.length > 0) {
  console.warn(`[WARN] No keys found for: ${missingProviders.join(", ")}`);
  console.warn("[WARN] Some LLM fallbacks may not work. Check your .env file.");
}
const app = express();
const PORT = process.env.PORT || 8000;

// Support comma-separated list of allowed origins, e.g.:
// CLIENT_URL=http://localhost:5173,https://invest-xxx.vercel.app
// On Vercel (experimentalServices), frontend+backend share the same domain — CORS not needed in prod
const rawOrigins = process.env.CLIENT_URL || "http://localhost:5173";
const allowedOrigins = rawOrigins.split(",").map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, Postman)
      if (!origin) return callback(null, true);
      // Allow all Vercel preview deployments automatically
      if (origin.endsWith(".vercel.app")) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.use("/api/research", researchRouter);

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message ?? "Internal server error" });
  }
});

app.get("/test-supplemental", async (req, res) => {
  const apiKey = process.env.RAPIDAPI_KEY_1;
  const url = `https://yahoo-finance15.p.rapidapi.com/api/v1/markets/stock/modules?ticker=INFY&module=financial-data,default-key-statistics`;
  
  const response = await fetch(url, {
    headers: {
      "x-rapidapi-host": "yahoo-finance166.p.rapidapi.com",
      "x-rapidapi-key": apiKey,
    }
  });

  const text = await response.text();
  res.send({ status: response.status, body: text });
});

app.get("/test-fin", async (req, res) => {
  const apiKey = process.env.RAPIDAPI_KEY_1;
  const url = `https://yahoo-finance166.p.rapidapi.com/api/stock/get-financial-data?symbol=INFY&region=US`;
  
  const response = await fetch(url, {
    headers: {
      "x-rapidapi-host": "yahoo-finance166.p.rapidapi.com",
      "x-rapidapi-key": apiKey,
    }
  });

  const json = await response.json();
  res.json(json);
});

app.listen(PORT, () => {
  console.log(`Investment Research Agent server running on http://localhost:${PORT}`);
  console.log(`CORS enabled for: ${allowedOrigins.join(", ")}`);
});
