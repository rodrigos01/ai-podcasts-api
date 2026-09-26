// Conservative ceiling for a single TTS submission (base prompt + chunk
// text combined), safely under Gemini TTS's stated "tens of thousands of
// tokens" context window per prompting-guide.md.
export const MAX_TTS_INPUT_TOKENS = 12_000;

// Cloud TTS's streamingSynthesize output sample rate (see geminiClient.ts's
// streamSpeech) — shared with utils/aacEncoder.ts (the PCM it's fed) and
// utils/adts.ts (duration math for the AAC it produces), so both sides of
// the encode always agree on the same rate.
export const TTS_SAMPLE_RATE_HERTZ = 24000;

// Target bitrate for the on-the-fly PCM->AAC encode (utils/aacEncoder.ts,
// migrated 2026-09-26 from requesting OGG_OPUS directly from Cloud TTS — see
// AGENTS.md). Chosen for speech-quality dialogue at a modest size; ffmpeg's
// native "aac" encoder doesn't hold this exactly per-frame (confirmed
// empirically — frame sizes vary even at a fixed target), so this is a
// target average, not a literal per-frame guarantee. `?t=` seeking doesn't
// depend on it being exact regardless — see utils/adts.ts's frame-counting
// approach.
export const AAC_BITRATE_KBPS = 64;

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
// Lowered from 500 back to 350 (2026-09-23) to fix voice-attribution drift:
// Gemini TTS's own recommendation is to keep a single synthesis call under
// ~3 minutes of audio, and 500 tokens was already observed to produce
// 115-125s chunks — comfortably under the ~178s RST_STREAM ceiling below,
// but well past the point where drift starts creeping in per Gemini TTS's
// guidance. 350 tokens tracks closer to that 3-minute recommendation.
//
// 500 was chosen (2026-09-21) specifically to make single-speaker chunks
// *rare*, because at the time `audio.service.ts` always declared both cast
// voices in `multiSpeakerVoiceConfig` regardless of which of them actually
// spoke in a chunk (Cloud TTS's `MultiSpeakerVoiceConfig` requires exactly
// two speaker configs) — that mismatch between a "two-voice dialogue"
// configuration and single-speaker content was a reproducible trigger for
// hallucinated interjections attributed to the silent voice, degenerate
// repetition loops, and voice misattribution.
//
// Rather than keep avoiding single-speaker chunks by widening the budget
// (which fights the 3-minute goal directly), `geminiClient.ts`'s
// streamSpeech now detects a single-speaker chunk (every turn in it shares
// one speaker — the common case at 350 tokens, per the kickoff-monologue
// structure and the oversized-turn fallback below) and synthesizes it with
// a genuine single-voice request instead of a 2-voice multi-speaker one, so
// there's no silent second voice for the model to hallucinate onto. This
// reverses an earlier evaluation of that same approach (rejected then for
// an observed increase in false-positive content-moderation rejections on
// plain single-voice requests) — confirmed live (2026-09-23): the
// single-voice shape does measurably fail more often (moderation
// false-positives, and separately `RST_STREAM`) than the multi-speaker
// shape. That higher failure rate used to be an unacceptable risk
// specifically for chunk 0 (the one chunk whose failure couldn't be
// silently skipped, since it used to carry the episode's only Ogg header) —
// fixed by decoupling the header from any chunk's own output, and later
// made moot entirely by the PCM/AAC migration (2026-09-26, see AGENTS.md):
// ADTS AAC chunks need no shared header at all, so every chunk's failure,
// chunk 0 included, is equally recoverable and the single-voice path's
// reliability tradeoff applies uniformly everywhere.
//
// This ~178s RST_STREAM ceiling is a function of the model's own output
// (tokens/duration), not the requested audioEncoding's byte size — confirmed
// by the person who found it originally — so switching the request from
// OGG_OPUS to PCM (2026-09-26) doesn't change where it triggers and this
// value didn't need retuning for that migration.
export const TARGET_CHUNK_TOKENS = 350;

// A single TTS call's synthesized audio is killed (the underlying gRPC
// stream destroyed, the call treated as a failure) once it exceeds this
// length — a safety net against Gemini TTS's own documented "degenerate
// repetition loop" behavior (see AGENTS.md/this file's history above):
// confirmed live (2026-09-23) that a chunk can, rarely, just never stop
// generating (no error, no natural end-of-stream), which without a cap
// would stream to a live listener indefinitely. Set comfortably above what
// a real ~350-token chunk should ever need (well under 3 minutes per the
// TARGET_CHUNK_TOKENS reasoning above) so this only ever fires on a
// genuine runaway, never a normal chunk. A killed chunk goes through the
// exact same retry/skip handling as any other TTS failure — see
// `generateOrJoin` in audio.service.ts.
export const MAX_CHUNK_AUDIO_SECONDS = 180;

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
