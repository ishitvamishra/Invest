import { fetchFinancialData } from "../tools/yahooFinance.js";
import { getEmitter } from "../../lib/helpers.js";

/**
 * Fetch financial data from Yahoo Finance.
 * @param {object} state
 * @param {object} config
 */
export async function financialDataNode(state, config) {
  const emitter = getEmitter(config);
  const nodeName = "financialData";
  const streamEvents = [];

  const emit = (type, message, data = null) => {
    if (emitter) emitter.emitEvent(type, nodeName, message, data);
    streamEvents.push({ type, node: nodeName, message, data, timestamp: Date.now() });
  };

  try {
    emit("node_start", `Fetching financial data for ${state.ticker ?? state.companyName}`);

    if (!state.ticker) {
      emit("error", "No ticker available — skipping financial data fetch");
      emit("node_complete", "Financial data unavailable (no ticker)");
      return {
        financialData: null,
        currentStep: "financialDataSkipped",
        streamEvents,
      };
    }

    emit("tool_call", `Fetching financial data: ${state.ticker}`);

    const financialData = await fetchFinancialData(
      state.ticker,
      state.exchange,
      state.companyName
    );

    if (financialData) {
      const source = financialData.source === "alphavantage" ? "Alpha Vantage" : "Yahoo Finance";
      emit("node_complete", `Financial data retrieved (${source}) for ${state.ticker}`, {
        marketCap: financialData.marketCap,
        peRatio: financialData.peRatio,
      });
    } else {
      emit("error", `Failed to fetch financial data for ${state.ticker}`);
      emit("node_complete", "Financial data unavailable");
    }

    return {
      financialData,
      currentStep: "financialDataComplete",
      streamEvents,
    };
  } catch (error) {
    const msg = `Financial data error: ${error.message}`;
    emit("error", msg);
    return {
      financialData: null,
      currentStep: "financialDataError",
      errors: [msg],
      streamEvents,
    };
  }
}
