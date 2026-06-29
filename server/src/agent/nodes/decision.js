import { callFastLLM, safeParseJSON } from "../../lib/llm.js";
import {
  callWithRetry,
  getResponseText,
  getEmitter,
} from "../../lib/helpers.js";

const DECISION_SYSTEM_PROMPT = `You are the Chief Investment Officer at a quantitative hedge fund. Make a final investment decision based on all provided research and analyst commentary.

Decision rules:
- INVEST: Strong fundamentals + positive catalysts + manageable risks + positive sentiment
- PASS: Poor fundamentals OR major red flags OR excessive valuation OR negative sentiment
- WATCH: Mixed signals, uncertain outlook, insufficient data, or needs monitoring

Be decisive. Base confidence score on data quality and signal clarity.
Respond ONLY with raw JSON — no markdown, no backticks, no extra text:
{
  "verdict": "INVEST" or "PASS" or "WATCH",
  "confidenceScore": <integer from 0 to 100>,
  "reasoning": "<2-3 sentences explaining the verdict clearly>"
}`;

/**
 * Final investment decision node.
 * @param {object} state
 * @param {object} config
 */
export async function decisionNode(state, config) {
  const emitter = getEmitter(config);
  const nodeName = "decision";
  const streamEvents = [];

  const emit = (type, message, data = null) => {
    if (emitter) emitter.emitEvent(type, nodeName, message, data);
    streamEvents.push({ type, node: nodeName, message, data, timestamp: Date.now() });
  };

  try {
    emit("node_start", "Making final investment decision");
    emit("llm_thinking", "Evaluating all signals for final verdict");

    const decisionPayload = {
      companyName: state.companyName,
      ticker: state.ticker,
      exchange: state.exchange,
      riskAppetite: state.riskAppetite,
      financialData: state.financialData,
      sentimentScore: state.sentimentScore,
      analystSummary: state.analystSummary,
      positiveFactors: state.positiveFactors,
      riskFactors: state.riskFactors,
      competitorAnalysis: state.competitorAnalysis,
      errors: state.errors,
    };

    const response = await callWithRetry(() =>
      callFastLLM([
        { role: "system", content: DECISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Make your final investment decision based on:\n\n${JSON.stringify(decisionPayload, null, 2)}`,
        },
      ])
    );

    const parsed = safeParseJSON(getResponseText(response));

    if (!parsed) {
      emit("error", "Failed to parse decision response");
      return {
        verdict: "WATCH",
        confidenceScore: 30,
        reasoning: "Unable to generate a confident decision due to parsing errors. Recommend manual review.",
        currentStep: "decisionError",
        errors: ["Failed to parse decision JSON response"],
        streamEvents,
      };
    }

    const verdict = ["INVEST", "PASS", "WATCH"].includes(parsed.verdict)
      ? parsed.verdict
      : "WATCH";
    const confidenceScore = Math.min(100, Math.max(0, Math.round(parsed.confidenceScore ?? 50)));

    emit("node_complete", `Verdict: ${verdict} (${confidenceScore}% confidence)`, {
      verdict,
      confidenceScore,
    });

    return {
      verdict,
      confidenceScore,
      reasoning: parsed.reasoning ?? "No reasoning provided.",
      currentStep: "decisionComplete",
      streamEvents,
    };
  } catch (error) {
    const msg = `Decision node error: ${error.message}`;
    emit("error", msg);
    return {
      verdict: "WATCH",
      confidenceScore: 0,
      reasoning: `Decision could not be completed: ${error.message}`,
      currentStep: "decisionError",
      errors: [msg],
      streamEvents,
    };
  }
}
