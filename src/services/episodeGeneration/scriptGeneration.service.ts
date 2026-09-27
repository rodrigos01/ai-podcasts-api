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

  const raw = await generatePlainText({
    systemInstruction: buildScriptSystemInstruction(cast, ctx),
    prompt: buildScriptGenerationPrompt(cast, wordTarget),
  });

  const turns = parseScriptTurns(raw);
  if (turns.length === 0) {
    throw new Error("Gemini returned a script with no recognizable turns");
  }
  validateSpeakerTurns(turns, labelA, labelB);

  const transcript = buildTranscript(
    turns.map((turn) => ({
      speakerName: turn.speaker,
      text: sanitizeTurnText(turn.text),
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
