/**
 * Centralised API base URL.
 *
 * - Development  → VITE_API_URL=http://localhost:8000  (set in .env.development)
 *   Vite's dev-server proxy also forwards /api → localhost:8000, so relative
 *   paths work too, but an explicit base is fine in dev.
 *
 * - Production   → VITE_API_URL=""  (set in .env.production)
 *   Requests go to /api/research on the SAME origin (Vercel serves both the
 *   static frontend and the /api/* serverless functions from one deployment).
 */
const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

/**
 * Returns the fully-qualified research endpoint URL.
 * Works in both dev (http://localhost:8000/api/research)
 * and prod (/api/research — same origin).
 */
export function getResearchUrl() {
  return `${API_BASE}/api/research`;
}

/**
 * Returns the health-check endpoint URL.
 */
export function getHealthUrl() {
  return `${API_BASE}/api/health`;
}

/**
 * Ping the backend health endpoint.
 * @returns {Promise<{ status: string, timestamp: number }>}
 */
export async function checkHealth() {
  const response = await fetch(getHealthUrl());
  return response.json();
}
