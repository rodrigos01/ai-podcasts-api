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
// limit that applied to the old bidi `streamingSynthesize` transport (see
// git history / AGENTS.md): it reset the connection (`13 INTERNAL: Received
// RST_STREAM`) once a single call's output audio got long enough — observed
// consistently at ~178s of audio for a ~950-token chunk. `synthesizeSpeech`
// (the current unary transport — geminiClient.ts's synthesizeChunkAudio)
// hasn't shown that failure, but this size is kept anyway since it's also
// what makes fast first-chunk playback possible in the first place.
export const TARGET_CHUNK_TOKENS = 350;

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
