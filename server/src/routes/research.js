import { Router } from "express";
import { z } from "zod";
import { researchGraph } from "../agent/graph.js";
import { createStreamEmitter } from "../lib/streamEmitter.js";

const router = Router();

const researchSchema = z.object({
  companyName: z.string().min(1, "Company name is required").max(200),
  riskAppetite: z.enum(["low", "medium", "high"]).optional().default("medium"),
});

router.post("/", async (req, res) => {
  let ended = false;

  const safeWrite = (data) => {
    if (ended || res.writableEnded) return;
    res.write(data);
  };

  const safeEnd = () => {
    if (ended || res.writableEnded) return;
    ended = true;
    res.end();
  };

  try {
    const parsed = researchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }

    const { companyName, riskAppetite } = parsed.data;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Mirror the request origin so SSE works from any allowed domain
    const requestOrigin = req.headers.origin;
    if (requestOrigin) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.flushHeaders?.();

    const emitter = createStreamEmitter();

    emitter.on("event", (event) => {
      safeWrite(`data: ${JSON.stringify(event)}\n\n`);
    });

    const initialState = {
      companyName: companyName.trim(),
      riskAppetite,
    };

    const finalState = await researchGraph.invoke(initialState, {
      configurable: { emitter },
    });

    if (!finalState.ticker) {
      emitter.emitEvent(
        "error",
        "tickerResolver",
        `Could not find a stock ticker for "${companyName}". Please try a different company name or use a publicly traded company.`,
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
    console.error("Research route error:", error);

    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
      return;
    }

    safeWrite(
      `data: ${JSON.stringify({
        type: "error",
        node: "server",
        message: error.message,
        data: null,
        timestamp: Date.now(),
      })}\n\n`
    );
    safeWrite(`data: [DONE]\n\n`);
    safeEnd();
  }
});

export default router;
