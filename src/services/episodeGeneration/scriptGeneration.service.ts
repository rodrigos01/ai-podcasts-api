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
import type { Cast, Speaker } from "./speakerSelection";

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
 * Resolves a possibly-drifted speaker label (see AGENTS.md's migration note —
 * a single-LLM script occasionally abbreviates a full name like "Maya Cruz"
 * down to "Maya") against the known 2-speaker cast. Accepts an exact match
 * first, then a case-insensitive exact match, then a case-insensitive
 * prefix/first-name match against exactly one speaker. Throws on anything
 * ambiguous or unmatched — chunker.ts and geminiClient.ts's TTS voice
 * assignment both key off the exact name string, so a wrong guess here is
 * worse than failing loudly and letting the caller retry the whole
 * generation.
 */
function resolveSpeakerLabel(rawLabel: string, speakers: [Speaker, Speaker]): string {
  const exact = speakers.find((s) => s.name === rawLabel);
  if (exact) return exact.name;

  const lower = rawLabel.toLowerCase();
  const caseInsensitive = speakers.filter((s) => s.name.toLowerCase() === lower);
  if (caseInsensitive.length === 1) return caseInsensitive[0]!.name;

  const prefixMatches = speakers.filter((s) => s.name.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0]!.name;

  const firstNameMatches = speakers.filter((s) => s.name.toLowerCase().split(/\s+/)[0] === lower);
  if (firstNameMatches.length === 1) return firstNameMatches[0]!.name;

  throw new Error(`Could not match speaker label "${rawLabel}" to a known cast member`);
}

/**
 * Normalizes every turn's speaker label against the known cast and throws if
 * either cast member never actually appears — a script that collapses onto
 * one voice would trip the "single-speaker chunk + 2-voice TTS config" bug
 * AGENTS.md documents (Cloud TTS's MultiSpeakerVoiceConfig requires exactly
 * two speaker configs regardless of who actually speaks in a chunk).
 */
export function normalizeSpeakerTurns(turns: ScriptTurn[], speakers: [Speaker, Speaker]): ScriptTurn[] {
  const normalized = turns.map((turn) => ({
    speaker: resolveSpeakerLabel(turn.speaker, speakers),
    text: turn.text,
  }));

  for (const speaker of speakers) {
    if (!normalized.some((turn) => turn.speaker === speaker.name)) {
      throw new Error(`Generated script never gives ${speaker.name} a line`);
    }
  }

  return normalized;
}

async function generateOnce(
  cast: Cast,
  ctx: ScriptGenerationContext,
  wordTarget: WordTarget,
): Promise<EpisodeScript> {
  const raw = await generatePlainText({
    systemInstruction: buildScriptSystemInstruction(cast, ctx),
    prompt: buildScriptGenerationPrompt(cast, wordTarget),
  });

  const turns = parseScriptTurns(raw);
  if (turns.length === 0) {
    throw new Error("Gemini returned a script with no recognizable turns");
  }

  const normalized = normalizeSpeakerTurns(turns, cast.speakers);
  const transcript = buildTranscript(
    normalized.map((turn) => ({ speakerName: turn.speaker, text: sanitizeTurnText(turn.text) })),
  );

  return { transcript, wordCount: countWords(transcript) };
}

/**
 * Replaces the old per-turn `runConversation` loop (conversationLoop.ts) with
 * a single call that writes the whole episode's script itself — see
 * AGENTS.md's migration note for why. Retries the whole generation on a
 * normalization failure (a bad/ambiguous speaker label, or a script that
 * drops one of the two speakers entirely) rather than failing the episode
 * outright: a fresh generation is cheap relative to what it protects against
 * (wrong TTS voice attribution).
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
