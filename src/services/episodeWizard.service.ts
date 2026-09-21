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

// No post-processing beyond the schema itself: unlike an earlier version of
// this file, there's no cross-entry convention left to repair (see
// wizard.schema.ts's episodeWizardOptionsResponseSchema) — each suggestion's
// shape is fully described by its own `episodes.length`, which Gemini's
// structured-output schema already grammar-constrains directly.

export async function generateSuggestions(
  podcast: Podcast,
  sources: Source[],
  length: EpisodeLength,
  prompt?: string,
): Promise<EpisodeWizardSuggestionsResponse> {
  return generateText({
    systemInstruction: episodeWizardSystemInstruction(podcast, length),
    prompt: buildEpisodeDraftPrompt(sources, prompt),
    schema: episodeWizardOptionsResponseSchema,
  });
}

export async function reviseSuggestions(
  podcast: Podcast,
  suggestions: EpisodeSuggestion[],
  length: EpisodeLength,
  targetSuggestionIndex: number,
  targetEpisodeIndex: number | undefined,
  instruction: string,
): Promise<EpisodeWizardSuggestionsResponse> {
  return generateText({
    systemInstruction: episodeWizardSystemInstruction(podcast, length),
    prompt: buildEpisodeRevisePrompt(suggestions, targetSuggestionIndex, targetEpisodeIndex, instruction),
    schema: episodeWizardOptionsResponseSchema,
  });
}
