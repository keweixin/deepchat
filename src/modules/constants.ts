/**
 * Shared constants for DeepChat frontend modules.
 * Centralizes magic numbers to improve maintainability and consistency.
 */

// ─── API & Network ──────────────────────────────────────────────────────────

/** Default fetch timeout (30s) */
export const API_TIMEOUT_MS = 30_000;

/** Native stream heartbeat: max silence before considering main process unresponsive */
export const NATIVE_HEARTBEAT_INTERVAL_MS = 30_000;

/** Native stream heartbeat polling interval */
export const NATIVE_HEARTBEAT_POLL_MS = 5_000;

/** Fallback cleanup timer if main process never sends done/error (10 min) */
export const NATIVE_FALLBACK_TIMEOUT_MS = 600_000;

/** Exponential backoff base delay */
export const RETRY_BASE_MS = 1_000;

/** Exponential backoff max delay */
export const RETRY_MAX_MS = 8_000;

/** Web search memory cache TTL */
export const SEARCH_CACHE_TTL_MS = 300_000; // 5 minutes

// ─── Persistence ────────────────────────────────────────────────────────────

/** localStorage save debounce interval */
export const SAVE_DEBOUNCE_MS = 250;

// ─── Rendering & Caches ─────────────────────────────────────────────────────

/** Markdown render cache max entries (LRU) */
export const MARKDOWN_RENDER_CACHE_LIMIT = 240;

/** Memory context cache TTL */
export const MEMORY_CONTEXT_CACHE_TTL_MS = 60_000;

/** Max conversations to scan for memory context */
export const MEMORY_CONTEXT_MAX_CONVERSATIONS = 20;

// ─── Virtual List ───────────────────────────────────────────────────────────

/** Default message height estimate (px) */
export const VIRTUAL_DEFAULT_HEIGHT = 120;

/** Enable virtual scrolling when message count exceeds this */
export const VIRTUAL_ENABLE_THRESHOLD = 30;

/** Buffer messages above/below viewport */
export const VIRTUAL_BUFFER = 3;

// ─── UI Feedback ────────────────────────────────────────────────────────────

/** Copy button "copied" feedback duration */
export const COPY_FEEDBACK_MS = 1_500;

/** Outline highlight duration for scroll-to-tool */
export const OUTLINE_HIGHLIGHT_MS = 2_000;

/** Streaming cursor blink/throttle intervals */
export const STREAMING_APPEND_THRESHOLD = 2_000;
export const STREAMING_FULL_SYNC_INTERVAL = 5_000;
