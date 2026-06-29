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
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

app.use(
  cors({
    origin: CLIENT_URL,
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

app.listen(PORT, () => {
  console.log(`Investment Research Agent server running on http://localhost:${PORT}`);
  console.log(`CORS enabled for: ${CLIENT_URL}`);
});
