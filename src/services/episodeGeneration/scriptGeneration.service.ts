import { generatePlainTextStream } from "../../llm/geminiClient";
import {
  buildScriptContinuationPrompt,
  buildScriptGenerationPrompt,
  buildScriptSystemInstruction,
  type ScriptGenerationContext,
  type WordTarget,
} from "../../llm/prompts/scriptGeneration.prompts";
import { countWords } from "../../utils/wordCount";
import { parseScriptTurns, type ScriptTurn } from "../../utils/scriptText";
import { isGenerationSuperseded } from "../../utils/generationLease";
import { buildTranscript } from "./transcriptBuilder";
import { speakerLabel, type Cast } from "./speakerSelection";

const MAX_GENERATION_ATTEMPTS = 3;

export interface EpisodeScript {
  transcript: string;
  wordCount: number;
  /**
   * Set when every generation attempt was exhausted but at least one TTS
   * chunk had already been sealed and exposed to a listener — see
   * `generateEpisodeScript`'s continuation-based recovery design. The
   * returned transcript is a real, complete, playable episode; it's just
   * shorter than the targeted word range because generation couldn't
   * finish.
   */
  incomplete?: boolean;
}

/**
 * A turn's own text must never contain a blank-line paragraph break —
 * transcriptBuilder.ts joins turns with "\n\n", and chunker.ts re-splits the
 * transcript on that exact separator to find turn boundaries. parseScriptTurns
 * already folds an unlabeled paragraph into the previous turn (rejoining with
 * "\n\n"), so this collapses that back down, the same invariant agent.ts's
 * sanitizeSpeech protected for the old per-turn pipeline.
 */
function sanitizeTurnText(text: string): string {
  return text.replace(/\n{2,}/g, " ").trim();
}

/**
 * A turn can parse with a speaker label but no spoken text at all — e.g.
 * "Maya:\nStyle: laughs" — the model's way of writing a pure non-verbal
 * reaction using the wrong slot for it (prompted against in
 * scriptGeneration.prompts.ts, but not structurally guaranteed). "Style:"
 * describes how a turn's own words are delivered, never a substitute for
 * them — sent as-is, an empty turn becomes an empty text part and the TTS
 * API rejects the whole request with "400 Missing text in content of type
 * text." Rather than lose the reaction, the style value is
 * treated as what it's actually describing — a momentary vocal burst — using
 * the same "<...>" inline-tag convention the prompt already teaches for
 * that. The style is dropped from the resulting turn since it's now the
 * turn's own text, not a separate delivery annotation on top of it.
 *
 * Only reached for a turn `reattachOrphanedStyle` didn't already resolve —
 * i.e. one with no same-speaker turn right after it to reattach the style
 * to, so it really does look like a standalone reaction rather than a
 * misplaced "Style:" line.
 */
export function resolveEmptyTurnText(turn: ScriptTurn): ScriptTurn {
  const text = sanitizeTurnText(turn.text);
  if (text.length > 0) return { speaker: turn.speaker, text, ...(turn.style ? { style: turn.style } : {}) };
  if (turn.style) return { speaker: turn.speaker, text: `<${turn.style.trim()}>` };
  return { speaker: turn.speaker, text: "" };
}

/**
 * The model has also been observed splitting a turn's own "Style:" line
 * into a separate, preceding empty turn instead of attaching it to the
 * turn it actually describes — e.g.
 *   Chloe:
 *   Style: deadpan
 *
 *   Chloe: <the actual line>
 * instead of the requested single turn
 *   Chloe: <the actual line>
 *   Style: deadpan
 * Both turns share a speaker and the first is otherwise a content-free
 * orphan, so unlike the pure-reaction case `resolveEmptyTurnText` handles,
 * there's an unambiguous real turn right here to reattach the style to.
 * Reattaching recovers the model's actual intent (a styled line) instead
 * of misreading the orphan as a standalone vocal burst. Runs before
 * `resolveEmptyTurnText` so only a genuinely standalone empty+style turn
 * (no same-speaker turn immediately following) reaches that fallback.
 */
export function reattachOrphanedStyle(turns: ScriptTurn[]): ScriptTurn[] {
  const merged: ScriptTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const next = turns[i + 1];
    if (sanitizeTurnText(turn.text).length === 0 && turn.style && next && next.speaker === turn.speaker) {
      merged.push({ speaker: next.speaker, text: next.text, style: next.style ?? turn.style });
      i++; // the next turn has been consumed into the merge above
      continue;
    }
    merged.push(turn);
  }
  return merged;
}

/**
 * Validates that every parsed turn uses one of the two labels we told the
 * model to use (see scriptGeneration.prompts.ts — first name only, unless
 * the cast shares a first name) and that both actually appear at least
 * once. No fuzzy resolution (case-insensitive/prefix/abbreviation matching)
 * — we ask for an exact, simple format and trust the model to produce it;
 * this only checks that it did, so a genuine miss surfaces as a clean
 * retry instead of a guessed-at correction. A script that used the wrong
 * label, or that collapses onto one voice, would otherwise reach Cloud
 * TTS's `multiSpeakerMarkup.turns` with an unrecognized or missing speaker
 * — the latter trips the documented "single-speaker chunk + 2-voice TTS
 * config" bug (MultiSpeakerVoiceConfig requires exactly two speaker
 * configs regardless of who actually speaks).
 */
export function validateSpeakerTurns(turns: ScriptTurn[], labelA: string, labelB: string): void {
  const unexpected = turns.find((turn) => turn.speaker !== labelA && turn.speaker !== labelB);
  if (unexpected) {
    throw new Error(
      `Script used an unexpected speaker label "${unexpected.speaker}" (expected only "${labelA}" or "${labelB}")`,
    );
  }
  if (!turns.some((turn) => turn.speaker === labelA)) {
    throw new Error(`Generated script never gives ${labelA} a line`);
  }
  if (!turns.some((turn) => turn.speaker === labelB)) {
    throw new Error(`Generated script never gives ${labelB} a line`);
  }
}

function turnToTranscriptTurn(turn: ScriptTurn) {
  return { speakerName: turn.speaker, text: turn.text, style: turn.style };
}

export interface ScriptStreamProgress {
  transcript: string;
  wordCount: number;
  /** Both expected speaker labels have appeared among the turns confirmed so far. */
  canSeal: boolean;
}

export interface ConsumeScriptStreamResult {
  turns: ScriptTurn[];
  seenA: boolean;
  seenB: boolean;
  /** `null` only on a fully clean completion (stream ended, both speakers seen). */
  error: unknown;
}

/**
 * Consumes a script-writing stream incrementally, validating and sanitizing
 * each newly-confirmed turn as it arrives rather than waiting for the whole
 * thing to finish — this is what lets `generateEpisodeScript` persist and
 * seal TTS chunks progressively instead of only once the full script comes
 * back. Takes a plain `AsyncGenerator<string>` of text deltas (not the
 * Gemini client directly), so it's trivially testable with a hand-written
 * fake generator.
 *
 * Seeded with `priorTurns`/`seenA`/`seenB` so a continuation attempt (see
 * `generateEpisodeScript`) can resume exactly where a previous attempt's
 * stream left off, carrying its validated progress forward rather than
 * starting from an empty turn list.
 *
 * Never throws — any problem (an unexpected speaker label, a stream-level
 * error, ending without both speakers ever appearing) is returned as
 * `error` alongside whatever turns *did* validate before the problem, so
 * the caller always has something to continue from instead of having to
 * discard progress on every failure.
 */
export async function consumeScriptStream(
  stream: AsyncGenerator<string>,
  priorTurns: ScriptTurn[],
  labelA: string,
  labelB: string,
  seenA: boolean,
  seenB: boolean,
  onProgress?: (progress: ScriptStreamProgress) => Promise<boolean>,
): Promise<ConsumeScriptStreamResult> {
  const turns = [...priorTurns];
  let exposed = false;

  async function emitProgress(): Promise<void> {
    if (!onProgress) return;
    const transcript = buildTranscript(turns.map(turnToTranscriptTurn));
    const sealed = await onProgress({ transcript, wordCount: countWords(transcript), canSeal: seenA && seenB });
    if (sealed) exposed = true;
  }

  // Folds a newly-confirmed batch of raw turns into `turns`, validating
  // and sanitizing them the same way the old one-shot generateOnce did for
  // the whole script at once — see reattachOrphanedStyle/resolveEmptyTurnText's
  // own doc comments. Only the *sanitized* (post-filter) turns count toward
  // "did labelA/labelB ever appear", matching validateSpeakerTurns's
  // original semantics exactly. Returns an error and stops as soon as one
  // sanitized turn uses neither expected label; everything confirmed
  // *before* it is kept. Operating on one batch at a time (rather than the
  // whole buffer) means reattachOrphanedStyle's one-turn lookahead can't
  // see across a batch boundary — an orphaned "Style:"-only turn that
  // lands right at the end of a batch, whose merge partner only arrives in
  // the next one, gets finalized standalone via resolveEmptyTurnText's
  // inline-tag fallback instead of merged. Cosmetic, not a correctness
  // issue: the resulting turn is still valid and correctly labeled.
  function foldBatch(rawBatch: ScriptTurn[]): Error | null {
    const sanitized = reattachOrphanedStyle(rawBatch)
      .map(resolveEmptyTurnText)
      .filter((turn) => turn.text.length > 0);
    for (const turn of sanitized) {
      if (turn.speaker !== labelA && turn.speaker !== labelB) {
        return new Error(
          `Script used an unexpected speaker label "${turn.speaker}" (expected only "${labelA}" or "${labelB}")`,
        );
      }
      if (turn.speaker === labelA) seenA = true;
      if (turn.speaker === labelB) seenB = true;
      turns.push(turn);
    }
    return null;
  }

  let buffer = "";
  let confirmedRawCount = 0;

  try {
    for await (const delta of stream) {
      buffer += delta;
      // The last parsed turn may still be growing — only fold turns before it.
      const confirmedRaw = parseScriptTurns(buffer).slice(0, -1);
      if (confirmedRaw.length > confirmedRawCount) {
        const newRaw = confirmedRaw.slice(confirmedRawCount);
        confirmedRawCount = confirmedRaw.length;
        const err = foldBatch(newRaw);
        if (err) return { turns, seenA, seenB, error: err };
        await emitProgress();
      }
    }
  } catch (err) {
    return { turns, seenA, seenB, error: err };
  }

  // Stream ended cleanly — fold whatever's left, including the final turn
  // (no longer "possibly still growing" now that the stream is done).
  const remainingRaw = parseScriptTurns(buffer).slice(confirmedRawCount);
  const err = foldBatch(remainingRaw);
  if (err) return { turns, seenA, seenB, error: err };

  if (turns.length === 0) {
    return { turns, seenA, seenB, error: new Error("Gemini returned a script with no turns containing spoken text") };
  }
  if (!seenA) {
    return { turns, seenA, seenB, error: new Error(`Generated script never gives ${labelA} a line`) };
  }
  if (!seenB) {
    return { turns, seenA, seenB, error: new Error(`Generated script never gives ${labelB} a line`) };
  }

  await emitProgress();
  return { turns, seenA, seenB, error: null };
}

/**
 * A script that was already partly written when this run started: the
 * transcript persisted by a run that stalled (its instance recycled or
 * throttled mid-generation), to be finished rather than rewritten.
 * `exposed` is whether TTS chunks were already sealed from it — i.e. whether a
 * listener may be on it — which decides, as for any run, whether running out
 * of attempts salvages a shorter episode or fails it.
 */
export interface ScriptSeed {
  transcript: string;
  exposed: boolean;
}

/**
 * The turns of a persisted transcript, and which of the two speakers have
 * spoken in it. Persisted transcripts are always the canonical output of
 * `buildTranscript` over already-validated turns, so they parse back exactly.
 */
export function seedFromTranscript(
  transcript: string,
  labelA: string,
  labelB: string,
): { turns: ScriptTurn[]; seenA: boolean; seenB: boolean } {
  const turns = parseScriptTurns(transcript);
  return {
    turns,
    seenA: turns.some((turn) => turn.speaker === labelA),
    seenB: turns.some((turn) => turn.speaker === labelB),
  };
}

/**
 * Replaces the old per-turn `runConversation` loop (conversationLoop.ts) with
 * a single call that writes the whole episode's script itself — see
 * AGENTS.md's migration note for why. Streams the call (`generatePlainTextStream`)
 * so `onProgress` can be called as turns are confirmed, letting the caller
 * (orchestrator.ts) persist the transcript and seal TTS chunks progressively
 * instead of waiting for the whole script.
 *
 * On any failure (an unexpected speaker label, a stream-level error, or a
 * script that drops one of the two speakers entirely), does NOT restart
 * from scratch — a fresh attempt is seeded with whatever turns the failed
 * attempt already validated (`buildScriptContinuationPrompt`) and asked to
 * continue naturally from there. Restarting would regenerate different
 * content for any TTS chunk a listener might already be partway through;
 * continuing never discards exposed progress. `exposed` tracks whether
 * `onProgress` ever reported sealing a chunk across the whole attempt
 * sequence — once every attempt (fresh + continuations) is exhausted: if
 * nothing was ever exposed, this throws exactly as the old non-streaming
 * version did; if something *was* exposed, it instead returns the
 * best-known-good transcript as a shorter-than-targeted but complete,
 * playable episode (`incomplete: true`) rather than cutting a listener off.
 *
 * With a `seed`, the run starts from the transcript a stalled run left behind
 * instead of an empty script: its first attempt is already a continuation.
 */
export async function generateEpisodeScript(
  cast: Cast,
  ctx: ScriptGenerationContext,
  wordTarget: WordTarget,
  onProgress?: (progress: ScriptStreamProgress) => Promise<boolean>,
  seed?: ScriptSeed,
): Promise<EpisodeScript> {
  const [a, b] = cast.speakers;
  const labelA = speakerLabel(a.name, b.name);
  const labelB = speakerLabel(b.name, a.name);

  const seeded = seed ? seedFromTranscript(seed.transcript, labelA, labelB) : null;
  let turns: ScriptTurn[] = seeded?.turns ?? [];
  let seenA = seeded?.seenA ?? false;
  let seenB = seeded?.seenB ?? false;
  let exposed = seed?.exposed ?? false;
  let lastError: unknown;

  // A run that stalled right at the end already has a script as long as it
  // was going to get; asking the model to "continue" past the target would
  // only make it ramble.
  if (seed && seenA && seenB && countWords(seed.transcript) >= wordTarget.max) {
    return { transcript: seed.transcript, wordCount: countWords(seed.transcript) };
  }

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const transcriptSoFar = buildTranscript(turns.map(turnToTranscriptTurn));
    const prompt =
      turns.length === 0
        ? buildScriptGenerationPrompt(cast, ctx, wordTarget)
        : buildScriptContinuationPrompt(cast, ctx, wordTarget, transcriptSoFar, countWords(transcriptSoFar));

    const stream = generatePlainTextStream({
      systemInstruction: buildScriptSystemInstruction(cast, ctx),
      prompt,
    });

    const result = await consumeScriptStream(stream, turns, labelA, labelB, seenA, seenB, async (progress) => {
      if (!onProgress) return false;
      const sealed = await onProgress(progress);
      if (sealed) exposed = true;
      return sealed;
    });

    turns = result.turns;
    seenA = result.seenA;
    seenB = result.seenB;

    if (result.error === null) {
      const transcript = buildTranscript(turns.map(turnToTranscriptTurn));
      return { transcript, wordCount: countWords(transcript) };
    }
    // Another run owns this episode now: stop, don't retry over its progress.
    if (isGenerationSuperseded(result.error)) throw result.error;
    lastError = result.error;
  }

  if (exposed && turns.length > 0) {
    const transcript = buildTranscript(turns.map(turnToTranscriptTurn));
    return { transcript, wordCount: countWords(transcript), incomplete: true };
  }
  throw lastError;
}
