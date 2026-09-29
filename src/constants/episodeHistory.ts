/**
 * How many earlier episodes' transcripts are fed into script generation and
 * the episode wizard as continuity context. A ceiling on prompt size (15 long
 * episodes is roughly 180k tokens, comfortably inside Gemini 3.8 Flash's 1M
 * window), not a target — a young show simply has fewer to send.
 */
export const MAX_HISTORY_EPISODES = 15;
