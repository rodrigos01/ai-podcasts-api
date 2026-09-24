// Gemini 3.8 Flash TTS migration: chunking is gone entirely (the old
// per-chunk constants — MAX_TTS_INPUT_TOKENS, TARGET_CHUNK_TOKENS,
// MAX_CHUNK_AUDIO_SECONDS, CHUNK_LOCK_* — existed only to work around Cloud
// TTS's ~178s-per-call ceiling; the investigation found the new model
// handles a whole episode, up to ~7,250 words tested, in one call with no
// splitting). An episode's whole transcript is now synthesized as one
// streaming `interactions.create` call — see llm/ttsClient.ts and
// services/audio.service.ts.

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

// A single episode's synthesized audio is treated as a runaway/failed
// generation once it exceeds this length — the episode-level equivalent of
// the old per-chunk MAX_CHUNK_AUDIO_SECONDS, guarding against Gemini TTS's
// documented "degenerate repetition loop" behavior, which without a cap
// could stream to a live listener indefinitely. Set well above the
// investigation's longest confirmed real episode (~1184s, ~20 minutes, for
// a ~7,250-word transcript) with real headroom for this app's longer
// `long`-length episodes (up to 9,000 words, not yet tested against this
// model — re-verify this ceiling once that's been tried live).
export const MAX_EPISODE_AUDIO_SECONDS = 2400;

// Cross-instance, per-episode generation lock (data/audioLock.repository.ts):
// how long a lock is honored before a waiting instance may assume its
// holder crashed and steal it. Generous relative to a whole episode's real
// generation time (up to MAX_EPISODE_AUDIO_SECONDS-ish of wall clock, plus
// retries) — much longer than the old per-chunk lock's 5 minutes, since one
// lock now covers an entire episode's single synthesis job rather than one
// ~1-minute chunk.
export const AUDIO_GENERATION_LOCK_TTL_MS = 40 * 60 * 1000;

// How often a waiting instance (a follower, or a listener joining after the
// generation leader) re-checks Storage for the leader's latest in-progress
// snapshot, or Firestore for the episode's lock/status to change.
export const AUDIO_POLL_INTERVAL_MS = 1_500;

// How often the in-progress WAV snapshot (storage/audioCache.repository.ts's
// putInProgressAudio) is flushed to Storage while a leader's synthesis is
// still running — frequent enough that a follower joining mid-generation
// isn't stuck waiting long for something to tail, without re-uploading on
// every single small delta.
export const IN_PROGRESS_FLUSH_INTERVAL_MS = 3_000;
