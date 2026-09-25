// Gemini 3.8 Flash TTS chunking: transcripts are broken down into chunks
// of turns (TURNS_PER_CHUNK), synthesized on demand as the user listens.

// Number of script turns per TTS synthesis chunk.
export const TURNS_PER_CHUNK = 10;

// How long to wait for the next streamed event before treating the call as
// stalled — confirmed empirically in the investigation's spike script: a
// genuinely healthy multi-hundred-second streamed call never saw a gap over
// ~1.1s between events, while a real stall went completely silent for 8+
// minutes with no error. 20s is generous relative to the healthy ceiling
// while still failing far short of "hangs indefinitely" (the transport
// enforces no timeout of its own). A stall can't be resumed — see
// ttsClient.ts's streamEpisodeSynthesis — so this always means retrying the
// whole call from scratch.
export const STREAM_INACTIVITY_TIMEOUT_MS = 20_000;

// Maximum synthesized audio duration for a single chunk before treating it
// as a runaway generation. 10 turns is typically 30-90 seconds of audio;
// 300s (5 minutes) provides ample headroom while catching infinite loops.
export const MAX_CHUNK_AUDIO_SECONDS = 300;

// A single episode's synthesized audio is treated as a runaway/failed
// generation once it exceeds this length — the episode-level ceiling.
export const MAX_EPISODE_AUDIO_SECONDS = 2400;

// Cross-instance, per-chunk generation lock (data/audioLock.repository.ts):
// how long a lock is honored before a waiting instance treats it as abandoned
// and steals it (5 minutes is generous for a single 10-turn chunk).
export const CHUNK_LOCK_TTL_MS = 5 * 60 * 1000;

// Polling interval while waiting for another instance to finish a chunk lock.
export const CHUNK_LOCK_POLL_INTERVAL_MS = 1_500;

// Polling interval while tailing or polling audio status.
export const AUDIO_POLL_INTERVAL_MS = 1_500;

