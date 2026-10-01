import { generatePlainText } from "../../llm/geminiClient";
import {
  buildScriptGenerationPrompt,
  buildScriptSystemInstruction,
  type ScriptGenerationContext,
  type WordTarget,
} from "../../llm/prompts/scriptGeneration.prompts";
import { countWords } from "../../utils/wordCount";
import { parseScriptTurns, type ScriptTurn } from "../../utils/scriptText";
import { buildTranscript } from "./transcriptBuilder";
import { speakerLabel, type Cast } from "./speakerSelection";

const MAX_GENERATION_ATTEMPTS = 3;

export interface EpisodeScript {
  transcript: string;
  wordCount: number;
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

async function generateOnce(
  cast: Cast,
  ctx: ScriptGenerationContext,
  wordTarget: WordTarget,
): Promise<EpisodeScript> {
  const [a, b] = cast.speakers;
  const labelA = speakerLabel(a.name, b.name);
  const labelB = speakerLabel(b.name, a.name);

  const scriptParams = {
    systemInstruction: buildScriptSystemInstruction(cast, ctx),
    prompt: buildScriptGenerationPrompt(cast, ctx, wordTarget),
  }
  const raw = await generatePlainText(scriptParams);

  const turns = parseScriptTurns(raw);
  if (turns.length === 0) {
    throw new Error("Gemini returned a script with no recognizable turns");
  }

  const sanitizedTurns = reattachOrphanedStyle(turns)
    .map(resolveEmptyTurnText)
    .filter((turn) => turn.text.length > 0);
  if (sanitizedTurns.length === 0) {
    throw new Error("Gemini returned a script with no turns containing spoken text");
  }
  validateSpeakerTurns(sanitizedTurns, labelA, labelB);

  const transcript = buildTranscript(
    sanitizedTurns.map((turn) => ({
      speakerName: turn.speaker,
      text: turn.text,
      style: turn.style,
    })),
  );

  return { transcript, wordCount: countWords(transcript) };
}

/**
 * Replaces the old per-turn `runConversation` loop (conversationLoop.ts) with
 * a single call that writes the whole episode's script itself — see
 * AGENTS.md's migration note for why. Retries the whole generation on a
 * validation failure (an unexpected speaker label, or a script that drops
 * one of the two speakers entirely) rather than failing the episode
 * outright: a fresh generation is cheap relative to what it protects
 * against (wrong TTS voice attribution).
 */
export async function generateEpisodeScript(
  cast: Cast,
  ctx: ScriptGenerationContext,
  wordTarget: WordTarget,
): Promise<EpisodeScript> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    try {
      return await generateOnce(cast, ctx, wordTarget);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
