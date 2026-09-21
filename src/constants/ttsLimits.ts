// Conservative ceiling for a single TTS submission (base prompt + chunk
// text combined), safely under Gemini TTS's stated "tens of thousands of
// tokens" context window per prompting-guide.md.
export const MAX_TTS_INPUT_TOKENS = 12_000;

// specs.md's "Audio Generation" section calls for audio to be generated
// on-demand and streamed back *as the user listens* — chunking purely up
// to MAX_TTS_INPUT_TOKENS would pack an entire short episode (or scene) into
// one TTS call, so the client waits for all of it to synthesize before
// playback can start. Target a much smaller practical chunk size instead,
// so the first chunk is ready quickly. Shared by both the Podcast episode
// chunker and the audiobook scene chunker.
//
// Also doubles as a safety margin against a real, empirically-confirmed
// limit: Cloud TTS's `streamingSynthesize` (see geminiClient.ts's
// streamSpeech) resets the connection (`13 INTERNAL: Received RST_STREAM`)
// once a single call's output audio gets long enough — observed
// consistently at ~178s of audio for a ~950-token chunk.
//
// Raised from 350 to 500 (2026-09-21) to fix a real quality bug, not just
// tuned for latency: chunker.ts packs whole turns into a chunk up to this
// budget, and since this app's conversation strictly alternates speakers,
// a chunk ends up containing only one speaker's turn(s) whenever a single
// turn's own size is a large fraction of the budget — most reliably the
// episode-opening "kickoff" turn, which specs.md deliberately makes a
// substantial uninterrupted monologue. `audio.service.ts` still declares
// *both* cast voices in `multiSpeakerVoiceConfig` for every chunk
// regardless (Cloud TTS's `MultiSpeakerVoiceConfig` requires exactly two
// speaker configs, even when only one of them actually speaks) — that
// mismatch between a "two-voice dialogue" configuration and single-speaker
// content was the reproducible trigger for a real production issue:
// hallucinated interjections attributed to the silent voice, degenerate
// repetition loops, and voice misattribution, confirmed by comparing
// per-token audio duration (single-speaker chunks ran 2-3x slower than
// normal pacing) and by direct listening.
//
// 350 tokens made this the *common* case (every episode's first two
// chunks, guaranteed by the kickoff-monologue structure). 500 tokens
// doesn't eliminate it — a real single-speaker chunk still occurred once
// in a 25-chunk test episode, when a turn's own size left too little
// budget for the next turn to join it — but empirically dropped it from
// "essentially guaranteed at the start of every episode" to "rare", while
// every observed chunk's synthesized duration (115-125s in that same test)
// stayed comfortably under the ~178s RST_STREAM ceiling above. A costlier,
// more complete fix (routing single-speaker chunks through genuine
// single-voice synthesis instead of the 2-voice multi-speaker call) was
// evaluated and rejected: Cloud TTS's plain single-voice request shape
// turned out to be inconsistently *more* prone to false-positive
// content-moderation rejections than the multi-speaker shape for
// identical, unproblematic text — confirmed empirically, including that
// relaxing `AdvancedVoiceOptions.safetySettings` to `BLOCK_ONLY_HIGH`
// fixed one such rejection but not another in the same test. If you want
// to close the remaining gap instead of just shrinking it further, prefer
// having the chunker pull in a partial slice of the next turn (splitting
// it, same as the existing oversized-single-turn fallback already does)
// over ever switching a chunk to single-voice synthesis.
export const TARGET_CHUNK_TOKENS = 500;

// Cross-instance chunk-generation lock (see data/audioLock.repository.ts /
// audiobookAudioLock.repository.ts): how long a lock is honored before a
// waiting instance is allowed to assume its holder died mid-generation and
// steal it. Generous relative to how long one chunk actually takes to
// synthesize at the current TARGET_CHUNK_TOKENS size (well under a minute,
// confirmed empirically), so it only kicks in on a genuine crash, not
// normal variance.
export const CHUNK_LOCK_TTL_MS = 5 * 60 * 1000;

// How often a waiting instance re-checks whether the chunk it's waiting on
// has been cached yet by whichever instance holds the lock.
export const CHUNK_LOCK_POLL_INTERVAL_MS = 1_500;

// How often /stream re-fetches the episode doc once it has caught up to
// every chunk sealed so far but the episode is still generating (see
// audio.service.ts) — distinct from CHUNK_LOCK_POLL_INTERVAL_MS, which polls
// Storage for one specific chunk's cached bytes, not Firestore for new chunk
// boundaries.
export const EPISODE_CHUNK_POLL_INTERVAL_MS = 1_500;
