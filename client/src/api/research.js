const API_URL = import.meta.env.VITE_API_URL || "";

/**
 * Get the research API endpoint URL.
 * @returns {string}
 */
export function getResearchUrl() {
  if (API_URL) {
    return `${API_URL}/api/research`;
  }
  return "/api/research";
}

/**
 * Check server health.
 * @returns {Promise<object>}
 */
export async function checkHealth() {
  const base = API_URL || "";
  const response = await fetch(`${base}/api/health`);
  return response.json();
}
