// Gemini 3.8 Flash TTS chunking: transcripts are broken down into chunks
// of turns (TURNS_PER_CHUNK), synthesized on demand as the user listens.

// Number of script turns per TTS synthesis chunk — an upper bound, not a
// fixed size: chunker.ts's chunkTranscript also stops a chunk early once
// MAX_WORDS_PER_CHUNK is reached, whichever limit comes first. See that
// constant for why the word cap exists.
export const TURNS_PER_CHUNK = 10;

// Gemini's `interactions.create` now outright rejects (not just eventually
// times out) a request whose synthesized audio would exceed ~300s — a hard
// server-side limit discovered live, not the soft "runaway generation"
// ceiling MAX_CHUNK_AUDIO_SECONDS below already guarded against. A fixed
// 10-turns-per-chunk size doesn't bound audio duration at all (a chunk of
// 10 short backchannel turns and a chunk of 10 long monologue turns produce
// wildly different audio lengths), so chunkTranscript also caps each
// chunk's word count, cutting a chunk short — even under 10 turns — the
// moment adding the next turn would push it over this word count. 650
// words is a proxy for audio duration, not audio duration itself: at a
// conversational ~150 words/minute (2.5 words/sec) speaking rate, 650
// words is ~260s of audio, leaving real margin under the 300s hard limit
// for the pacing/pause variance real TTS output has. This is the same
// content-size-bound approach the pre-3.8 Cloud TTS pipeline's deleted
// chunker used (there, token count, for a different technical ceiling —
// see AGENTS.md) — reintroduced here because turn count alone doesn't
// protect against this new limit. A single turn whose own text exceeds
// this cap gets split into several same-speaker continuation chunks
// instead of one over-limit chunk (chunker.ts's splitOversizedSpan/
// splitTextByWordBudget, preferring sentence-boundary cuts) — unlike a
// truly ambiguous mid-transcript cut, there's no speaker to guess at here,
// since it's still the same turn's own speaker throughout.
export const MAX_WORDS_PER_CHUNK = 650;

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

// Client-side abort threshold for a single chunk's synthesized audio,
// checked live as PCM deltas arrive (ttsClient.ts's consumeInteractionStream)
// — a defense-in-depth backstop, not the primary guard against Gemini's
// ~300s hard server-side limit (see MAX_WORDS_PER_CHUNK above, which sizes
// chunks to stay under that limit proactively, before the request is even
// sent). Deliberately the same 300s: MAX_WORDS_PER_CHUNK's word-count
// estimate could undershoot real audio duration for unusually slow/drawn-
// out delivery, and this is what catches that case (or any other runaway
// generation) rather than streaming indefinitely.
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

