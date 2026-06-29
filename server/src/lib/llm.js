import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";

/** @type {ChatGroq[]|null} */
let groqPool = null;
/** @type {ChatGoogleGenerativeAI[]|null} */
let geminiPool = null;
/** @type {ChatOpenAI[]|null} */
let cerebrasPool = null;

// ── Key helpers ────────────────────────────────────────────────────

/**
 * Read and sanitize a single env key.
 * @param {string} name
 * @returns {string|null}
 */
function getEnvKey(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (value.includes("your_") || value.endsWith("_here")) return null;
  return value;
}

/**
 * Read a pool of up to 5 keys for a provider.
 * Reads: NAME, NAME_1, NAME_2, NAME_3, NAME_4
 * @param {string} baseName
 * @returns {string[]}
 */
function getEnvKeys(baseName) {
  const keys = ["", "_1", "_2", "_3", "_4"]
    .map((suffix) => getEnvKey(`${baseName}${suffix}`))
    .filter(Boolean);
  return [...new Set(keys)];
}

/**
 * @param {string|null} key
 * @param {RegExp} pattern
 */
function matchesKeyFormat(key, pattern) {
  return Boolean(key && pattern.test(key));
}

// ── Pool builders (lazily cached) ─────────────────────────────────

function getGroqPool() {
  if (groqPool) return groqPool;
  groqPool = getEnvKeys("GROQ_API_KEY").map(
    (apiKey) =>
      // llama-3.3-70b-versatile: current active model (llama3-70b-8192 decommissioned June 2026)
      new ChatGroq({ model: "llama-3.3-70b-versatile", temperature: 0.2, apiKey })
  );
  return groqPool;
}

function getGeminiPool() {
  if (geminiPool) return geminiPool;
  geminiPool = getEnvKeys("GOOGLE_API_KEY")
    .filter((k) => matchesKeyFormat(k, /^(AIza|AQ\.)/))
    .map(
      (apiKey) =>
        // gemini-2.5-flash: latest fast model from Google
        new ChatGoogleGenerativeAI({
          model: "gemini-2.5-flash",
          temperature: 0.3,
          maxOutputTokens: 8192,
          json: true,
          apiKey,
        })
    );
  return geminiPool;
}

function getCerebrasPool() {
  if (cerebrasPool) return cerebrasPool;
  cerebrasPool = getEnvKeys("CEREBRAS_API_KEY").map(
    (apiKey) =>
      // llama3.1-8b: correct Cerebras model ID (no dash: llama3.1-8b not llama-3.1-8b)
      new ChatOpenAI({
        model: "llama3.1-8b",
        temperature: 0.3,
        apiKey,
        configuration: {
          baseURL: "https://api.cerebras.ai/v1",
          apiKey,
          defaultHeaders: { "X-Cerebras-3rd-Party-Integration": "langchain" },
        },
      })
  );
  return cerebrasPool;
}

// ── Backwards-compat shims ─────────────────────────────────────────

/** @deprecated */
export const fastLLM = { invoke: (m) => getGroqPool()[0]?.invoke(m) };
/** @deprecated */
export const smartLLM = { invoke: (m) => getGeminiPool()[0]?.invoke(m) };
/** @deprecated */
export const fallbackLLM = { invoke: (m) => getCerebrasPool()[0]?.invoke(m) };

// ── Core invocation ───────────────────────────────────────────────

/**
 * Try every LLM in a provider's key pool in sequence.
 * Returns the first successful response, or null if all keys fail.
 * @param {string} providerName
 * @param {Array} pool
 * @param {Array} messages
 * @returns {Promise<object|null>}
 */
async function tryPool(providerName, pool, messages) {
  if (!pool || pool.length === 0) {
    console.warn(`[LLM] ${providerName} skipped — no keys configured`);
    return null;
  }

  for (let i = 0; i < pool.length; i++) {
    const tag = pool.length > 1 ? ` key ${i + 1}/${pool.length}` : "";
    try {
      const response = await pool[i].invoke(messages);
      console.log(`[LLM] ${providerName}${tag} ✓`);
      return response;
    } catch (error) {
      const msg = String(error.message ?? error);
      console.warn(`[LLM] ${providerName}${tag} failed: ${msg.slice(0, 200)}`);
      // continue to next key in pool
    }
  }

  console.warn(`[LLM] ${providerName} — all ${pool.length} key(s) exhausted`);
  return null;
}

/**
 * Try provider pools in priority order until one succeeds.
 * @param {Array<[string, Array]>} chain  [[providerName, pool], …]
 * @param {Array} messages
 */
async function invokeChain(chain, messages) {
  for (const [name, pool] of chain) {
    const response = await tryPool(name, pool, messages);
    if (response) return response;
  }
  throw new Error(
    "All LLM providers and key pools exhausted. " +
    "Add more keys (GROQ_API_KEY_2, GOOGLE_API_KEY_2, …) in server/.env"
  );
}

// ── Public API ────────────────────────────────────────────────────

/**
 * FAST chain: Groq (all keys) → Cerebras (all keys) → Gemini (all keys)
 * @param {Array} messages
 */
export async function callFastLLM(messages) {
  return invokeChain(
    [
      ["Groq", getGroqPool()],
      ["Cerebras", getCerebrasPool()],
      ["Gemini", getGeminiPool()],
    ],
    messages
  );
}

/**
 * SMART chain: Gemini (all keys) → Cerebras (all keys) → Groq (all keys)
 * @param {Array} messages
 */
export async function callSmartLLM(messages) {
  return invokeChain(
    [
      ["Gemini", getGeminiPool()],
      ["Cerebras", getCerebrasPool()],
      ["Groq", getGroqPool()],
    ],
    messages
  );
}

/**
 * Validate API key pools and log pool sizes at startup.
 */
export function validateApiKeys() {
  const groqKeys = getEnvKeys("GROQ_API_KEY");
  const geminiKeys = getEnvKeys("GOOGLE_API_KEY").filter((k) =>
    matchesKeyFormat(k, /^(AIza|AQ\.)/)
  );
  const cerebrasKeys = getEnvKeys("CEREBRAS_API_KEY");

  const warnings = [];

  if (groqKeys.length === 0) {
    warnings.push("GROQ_API_KEY missing — get one at console.groq.com");
  } else {
    const bad = groqKeys.filter((k) => !matchesKeyFormat(k, /^gsk_/));
    if (bad.length) warnings.push(`${bad.length} Groq key(s) have unexpected format (expected gsk_)`);
  }

  if (geminiKeys.length === 0) {
    const raw = getEnvKeys("GOOGLE_API_KEY");
    warnings.push(
      raw.length === 0
        ? "GOOGLE_API_KEY missing — get one at aistudio.google.com"
        : "GOOGLE_API_KEY format unrecognized — expected AIza... or AQ...."
    );
  }

  if (cerebrasKeys.length === 0) {
    warnings.push("CEREBRAS_API_KEY missing — get one at cloud.cerebras.ai");
  } else {
    const bad = cerebrasKeys.filter((k) => !matchesKeyFormat(k, /^csk-/));
    if (bad.length) warnings.push(`${bad.length} Cerebras key(s) have unexpected format (expected csk-)`);
  }

  if (warnings.length > 0) {
    console.warn("[WARN] LLM API key issues:");
    warnings.forEach((w) => console.warn(`  • ${w}`));
  } else {
    console.log(
      `[LLM] Key pools ready — Groq: ${groqKeys.length}, Gemini: ${geminiKeys.length}, Cerebras: ${cerebrasKeys.length}`
    );
  }
}



/**
 * Strip markdown fences and isolate the JSON object.
 * @param {string} text
 * @returns {string}
 */
function normalizeJsonText(text) {
  let clean = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end > start) {
    clean = clean.slice(start, end + 1);
  }

  return clean;
}

/**
 * Attempt to close a truncated JSON string.
 * @param {string} partial
 * @returns {string}
 */
function closePartialJson(partial) {
  let result = partial.trim();

  const quoteCount = (result.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    result += '"';
  }

  result = result.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
  result = result.replace(/,\s*$/, "");

  let braces = 0;
  let brackets = 0;
  for (const ch of result) {
    if (ch === "{") braces++;
    if (ch === "}") braces--;
    if (ch === "[") brackets++;
    if (ch === "]") brackets--;
  }

  while (brackets > 0) {
    result += "]";
    brackets--;
  }
  while (braces > 0) {
    result += "}";
    braces--;
  }

  return result;
}

/**
 * Extract a JSON string field, including multiline values with literal newlines.
 * @param {string} text
 * @param {string} key
 * @returns {string|null}
 */
function extractStringField(text, key) {
  const marker = `"${key}"`;
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  let i = idx + marker.length;
  while (i < text.length && /[\s:]/.test(text[i])) i++;
  if (text[i] !== '"') return null;

  i++;
  let value = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "n") value += "\n";
      else if (next === '"') value += '"';
      else if (next === "\\") value += "\\";
      else value += next;
      i += 2;
      continue;
    }
    if (ch === '"') break;
    value += ch;
    i++;
  }

  return value || null;
}

/**
 * Extract a JSON array field from text.
 * @param {string} text
 * @param {string} key
 * @returns {string[]|null}
 */
function extractArrayField(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]*?\\])`));
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    const items = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")
    );
    return items.length ? items : null;
  }
}

/**
 * Field-level extraction when full JSON.parse fails.
 * @param {string} text
 * @returns {object|null}
 */
function extractJsonFields(text) {
  const result = {};

  const executiveSummary = extractStringField(text, "executiveSummary");
  const analystCommentary = extractStringField(text, "analystCommentary");
  const reasoning = extractStringField(text, "reasoning");
  const competitorSummary = extractStringField(text, "competitorSummary");
  const summary = extractStringField(text, "summary");
  const verdict = extractStringField(text, "verdict");
  const positiveFactors = extractArrayField(text, "positiveFactors");
  const riskFactors = extractArrayField(text, "riskFactors");
  const mainCompetitors = extractArrayField(text, "mainCompetitors");

  if (executiveSummary) result.executiveSummary = executiveSummary;
  if (analystCommentary) result.analystCommentary = analystCommentary;
  if (reasoning) result.reasoning = reasoning;
  if (competitorSummary) result.competitorSummary = competitorSummary;
  if (summary) result.summary = summary;
  if (verdict) result.verdict = verdict;
  if (positiveFactors) result.positiveFactors = positiveFactors;
  if (riskFactors) result.riskFactors = riskFactors;
  if (mainCompetitors) result.mainCompetitors = mainCompetitors;

  const sentimentMatch = text.match(/"overallSentiment"\s*:\s*(-?\d+(?:\.\d+)?)/);
  const confidenceMatch = text.match(/"confidenceScore"\s*:\s*(\d+)/);
  if (sentimentMatch) result.overallSentiment = Number(sentimentMatch[1]);
  if (confidenceMatch) result.confidenceScore = Number(confidenceMatch[1]);

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Helper to safely parse JSON from LLM response with recovery strategies.
 * @param {string} raw
 * @returns {object|null}
 */
export function safeParseJSON(raw) {
  if (!raw) return null;

  const text = typeof raw === "string" ? raw : String(raw);
  const normalized = normalizeJsonText(text);

  const attempts = [text.trim(), normalized, closePartialJson(normalized)];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try next strategy
    }
  }

  const extracted = extractJsonFields(normalized);
  if (extracted) {
    console.warn("[LLM] JSON partially recovered from malformed LLM response");
    return extracted;
  }

  console.error("[LLM] JSON parse failed. Raw response:", text.slice(0, 500));
  return null;
}

/**
 * Parse analyst-specific JSON with minimum required fields check.
 * @param {string} raw
 * @returns {object|null}
 */
export function parseAnalystJSON(raw) {
  const parsed = safeParseJSON(raw);
  if (!parsed) return null;

  const hasContent =
    parsed.executiveSummary ||
    parsed.analystCommentary ||
    (parsed.positiveFactors?.length ?? 0) > 0 ||
    (parsed.riskFactors?.length ?? 0) > 0;

  if (!hasContent) return null;

  return {
    executiveSummary: parsed.executiveSummary ?? "Analysis complete.",
    positiveFactors: Array.isArray(parsed.positiveFactors) ? parsed.positiveFactors : [],
    riskFactors: Array.isArray(parsed.riskFactors) ? parsed.riskFactors : [],
    analystCommentary: parsed.analystCommentary ?? parsed.executiveSummary ?? "",
  };
}
