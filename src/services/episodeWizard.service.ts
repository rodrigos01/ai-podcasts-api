import { generateText } from "../llm/geminiClient";
import {
  buildEpisodeDraftPrompt,
  buildEpisodeRevisePrompt,
  episodeWizardSystemInstruction,
} from "../llm/prompts/episodeWizard.prompts";
import type { EpisodeLength } from "../constants/lengthRanges";
import type { Podcast } from "../schemas/podcast.schema";
import type { Source } from "../schemas/source.schema";
import {
  episodeWizardOptionsResponseSchema,
  type EpisodeSuggestion,
  type EpisodeWizardSuggestionsResponse,
} from "../schemas/wizard.schema";

/**
 * Repairs the model's suggestions array into the shape clients rely on:
 * exactly one single-episode suggestion first, and — only if the model
 * actually returned one — exactly one 2-episode split second. Gemini's
 * structured-output schema can constrain each suggestion's own shape (an
 * `episodes` array of 1-2 drafts) but can't express this cross-entry
 * ordering/uniqueness rule, so the model occasionally returns something
 * schema-valid but out of convention (reordered, or two 1-episode entries)
 * — most often on revise, since that asks it to reproduce an existing
 * structure while also applying a free-text edit. This used to be a hard
 * `.check()` rejection in wizard.schema.ts, which meant a single
 * off-by-convention response failed the whole request; repairing it here
 * instead means the caller never sees the mismatch.
 */
export function normalizeSuggestions(suggestions: EpisodeSuggestion[]): EpisodeSuggestion[] {
  const single = suggestions.find((s) => s.episodes.length === 1);
  const split = suggestions.find((s) => s.episodes.length === 2);

  const result: EpisodeSuggestion[] = [];
  if (single) {
    result.push(single);
  } else if (split) {
    // No single-episode suggestion came back at all — fall back to the
    // split's own first episode so callers can still rely on
    // suggestions[0] existing as a single-episode option.
    result.push({ episodes: [split.episodes[0]!] });
  }
  if (split) {
    result.push(split);
  }
  return result;
}

export async function generateSuggestions(
  podcast: Podcast,
  sources: Source[],
  length: EpisodeLength,
  prompt?: string,
): Promise<EpisodeWizardSuggestionsResponse> {
  const result = await generateText({
    systemInstruction: episodeWizardSystemInstruction(podcast, length),
    prompt: buildEpisodeDraftPrompt(sources, prompt),
    schema: episodeWizardOptionsResponseSchema,
  });
  return { suggestions: normalizeSuggestions(result.suggestions) };
}

export async function reviseSuggestions(
  podcast: Podcast,
  suggestions: EpisodeSuggestion[],
  length: EpisodeLength,
  targetSuggestionIndex: number,
  targetEpisodeIndex: number | undefined,
  instruction: string,
): Promise<EpisodeWizardSuggestionsResponse> {
  const result = await generateText({
    systemInstruction: episodeWizardSystemInstruction(podcast, length),
    prompt: buildEpisodeRevisePrompt(suggestions, targetSuggestionIndex, targetEpisodeIndex, instruction),
    schema: episodeWizardOptionsResponseSchema,
  });
  return { suggestions: normalizeSuggestions(result.suggestions) };
}
