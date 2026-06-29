import { z } from "zod";
import { researchGraph } from "../server/src/agent/graph.js";
import { createStreamEmitter } from "../server/src/lib/streamEmitter.js";
import { validateApiKeys } from "../server/src/lib/llm.js";

validateApiKeys();

const researchSchema = z.object({
  companyName: z.string().min(1, "Company name is required").max(200),
  riskAppetite: z.enum(["low", "medium", "high"]).optional().default("medium"),
});

// Allowed origins — comma-separated CLIENT_URL env var, with hardcoded fallbacks
const rawOrigins = process.env.CLIENT_URL
  || "http://localhost:5173,https://invest-seven-delta.vercel.app";
const ALLOWED_ORIGINS = rawOrigins.split(",").map((o) => o.trim()).filter(Boolean);

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let ended = false;
  const safeWrite = (data) => {
    if (ended || res.writableEnded) return;
    try { res.write(data); } catch (_) {}
  };
  const safeEnd = () => {
    if (ended || res.writableEnded) return;
    ended = true;
    try { res.end(); } catch (_) {}
  };

  try {
    const parsed = researchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }

    const { companyName, riskAppetite } = parsed.data;

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    if (res.flushHeaders) res.flushHeaders();

    const emitter = createStreamEmitter();
    emitter.on("event", (event) => {
      safeWrite(`data: ${JSON.stringify(event)}\n\n`);
    });

    const finalState = await researchGraph.invoke(
      { companyName: companyName.trim(), riskAppetite },
      { configurable: { emitter } }
    );

    if (!finalState.ticker) {
      emitter.emitEvent(
        "error",
        "tickerResolver",
        `Could not find a stock ticker for "${companyName}". Please try a different company name.`,
        { companyName }
      );
      safeWrite(`data: [DONE]\n\n`);
      safeEnd();
      return;
    }

    const report = {
      companyName: finalState.companyName,
      ticker: finalState.ticker,
      exchange: finalState.exchange,
      riskAppetite: finalState.riskAppetite,
      verdict: finalState.verdict,
      confidenceScore: finalState.confidenceScore,
      reasoning: finalState.reasoning,
      financialData: finalState.financialData,
      newsResults: finalState.newsResults,
      sentimentScore: finalState.sentimentScore,
      competitorAnalysis: finalState.competitorAnalysis,
      positiveFactors: finalState.positiveFactors,
      riskFactors: finalState.riskFactors,
      analystSummary: finalState.analystSummary,
      reportSections: finalState.reportSections,
      errors: finalState.errors,
    };

    emitter.emitEvent("final_report", "reportBuilder", "Research complete", report);
    safeWrite(`data: [DONE]\n\n`);
    safeEnd();
  } catch (error) {
    console.error("Research handler error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
      return;
    }
    safeWrite(`data: ${JSON.stringify({ type: "error", node: "server", message: error.message, data: null, timestamp: Date.now() })}\n\n`);
    safeWrite(`data: [DONE]\n\n`);
    safeEnd();
  }
}
