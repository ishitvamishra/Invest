import { callSmartLLM, parseAnalystJSON } from "../../lib/llm.js";
import {
  callWithRetry,
  getResponseText,
  getEmitter,
} from "../../lib/helpers.js";

const ANALYST_SYSTEM_PROMPT = `You are a senior investment analyst at a top-tier hedge fund with 20 years of experience. Analyze all provided research data critically and produce a professional investment analysis. Be direct, data-driven, and honest. Do not be overly optimistic or pessimistic. Think like a fiduciary — your clients money depends on this analysis.
Respond ONLY with raw JSON — no markdown, no backticks, no extra text:
{
  "executiveSummary": "<3-4 sentences>",
  "positiveFactors": ["<string>", "<string>", ...],
  "riskFactors": ["<string>", "<string>", ...],
  "analystCommentary": "<4-6 paragraphs separated by newline characters>"
}

CRITICAL JSON RULES:
- Output valid JSON only — escape all quotes inside strings with backslash
- Use \\n for paragraph breaks inside analystCommentary — do NOT use literal line breaks inside JSON string values
- Keep analystCommentary under 800 words`;

const ANALYST_RETRY_PROMPT = `You are a senior investment analyst. Return ONLY valid raw JSON with no markdown.
Use \\n for paragraph breaks (not literal newlines). Keep analystCommentary to 2-3 short paragraphs.
{
  "executiveSummary": "<2-3 sentences>",
  "positiveFactors": ["<string>", "<string>"],
  "riskFactors": ["<string>", "<string>"],
  "analystCommentary": "<2-3 paragraphs with \\n between them>"
}`;

/**
 * Build the research payload sent to the analyst LLM.
 * @param {object} state
 */
function buildResearchPayload(state) {
  return {
    companyName: state.companyName,
    ticker: state.ticker,
    exchange: state.exchange,
    riskAppetite: state.riskAppetite,
    financialData: state.financialData ?? "Financial data unavailable",
    sentimentScore: state.sentimentScore,
    newsResults: state.newsResults?.slice(0, 6),
    webResearch: state.webResearch?.slice(0, 8).map((r) => ({
      query: r.query,
      title: r.title,
      snippet: r.snippet?.slice(0, 150),
    })),
    competitorAnalysis: state.competitorAnalysis,
  };
}

/**
 * Senior analyst synthesis node.
 * @param {object} state
 * @param {object} config
 */
export async function analystNode(state, config) {
  const emitter = getEmitter(config);
  const nodeName = "analyst";
  const streamEvents = [];

  const emit = (type, message, data = null) => {
    if (emitter) emitter.emitEvent(type, nodeName, message, data);
    streamEvents.push({ type, node: nodeName, message, data, timestamp: Date.now() });
  };

  try {
    emit("node_start", `Running AI analysis for ${state.companyName}`);
    emit("llm_thinking", "Synthesizing all research data");

    const researchPayload = buildResearchPayload(state);
    const payloadText = JSON.stringify(researchPayload, null, 2);

    const response = await callWithRetry(() =>
      callSmartLLM([
        { role: "system", content: ANALYST_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Analyze the following research data and provide your investment analysis:\n\n${payloadText}`,
        },
      ])
    );

    emit("llm_thinking", "Processing analyst recommendations");

    let parsed = parseAnalystJSON(getResponseText(response));

    if (!parsed) {
      emit("llm_thinking", "Retrying with compact JSON format");
      const retryResponse = await callSmartLLM([
        { role: "system", content: ANALYST_RETRY_PROMPT },
        {
          role: "user",
          content: `Analyze this data and return valid JSON only:\n\n${payloadText}`,
        },
      ]);
      parsed = parseAnalystJSON(getResponseText(retryResponse));
    }

    if (!parsed) {
      emit("error", "Failed to parse analyst response");
      return {
        analystSummary: null,
        positiveFactors: [],
        riskFactors: [],
        currentStep: "analystError",
        errors: ["Failed to parse analyst JSON response"],
        streamEvents,
      };
    }

    emit("node_complete", "Investment analysis complete", {
      positiveCount: parsed.positiveFactors?.length ?? 0,
      riskCount: parsed.riskFactors?.length ?? 0,
    });

    return {
      analystSummary: parsed,
      positiveFactors: parsed.positiveFactors ?? [],
      riskFactors: parsed.riskFactors ?? [],
      currentStep: "analystComplete",
      streamEvents,
    };
  } catch (error) {
    const msg = `Analyst node error: ${error.message}`;
    emit("error", msg);
    return {
      analystSummary: null,
      positiveFactors: [],
      riskFactors: [],
      currentStep: "analystError",
      errors: [msg],
      streamEvents,
    };
  }
}
