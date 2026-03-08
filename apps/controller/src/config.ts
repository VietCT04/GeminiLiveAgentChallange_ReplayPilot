const defaultApiBaseUrl = 'http://localhost:8080';

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim() || defaultApiBaseUrl;

export const USE_ORCHESTRATOR_START =
  (import.meta.env.VITE_USE_ORCHESTRATOR_START ?? 'false').toLowerCase() ===
  'true';
