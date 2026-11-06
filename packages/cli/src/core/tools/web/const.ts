// Browser agent
export const USER_AGENT = "Mozilla/5.0 (compatible; GamaResearchBot/1.0)";

// Redirect cap
export const MAX_REDIRECTS = 5;

// Body cap
export const MAX_BODY_BYTES = 2_000_000;

// Text cap
export const DEFAULT_MAX_CHARS = 20_000;

// Redirect codes
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
