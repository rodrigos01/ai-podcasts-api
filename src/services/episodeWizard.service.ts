import type { z } from "zod";
import { generateText } from "../llm/geminiClient";
import {
  buildEpisodeDraftPrompt,
  buildEpisodeRedraftPrompt,
  buildEpisodeRevisePrompt,
  episodeRedraftSystemInstruction,
  episodeWizardSystemInstruction,
} from "../llm/prompts/episodeWizard.prompts";
import type { PriorEpisode } from "../utils/episodeHistory";
import type { EpisodeLength } from "../constants/lengthRanges";
import type { Episode } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import type { Source } from "../schemas/source.schema";
import {
  episodeDraftSchema,
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
  previousEpisodes: PriorEpisode[],
  prompt?: string,
  // Continue the series' stored interaction instead of sending the transcripts
  // (podcasts on interaction context; see services/episodeGeneration/continuity.ts).
  previousInteractionId?: string,
): Promise<EpisodeWizardSuggestionsResponse> {
  return generateText({
    systemInstruction: episodeWizardSystemInstruction(podcast, length, previousEpisodes, previousInteractionId !== undefined),
    prompt: buildEpisodeDraftPrompt(sources, prompt),
    schema: episodeWizardOptionsResponseSchema,
    ...(previousInteractionId ? { previousInteractionId } : {}),
  });
}

export async function reviseSuggestions(
  podcast: Podcast,
  suggestions: EpisodeSuggestion[],
  length: EpisodeLength,
  previousEpisodes: PriorEpisode[],
  targetSuggestionIndex: number,
  targetEpisodeIndex: number | undefined,
  instruction: string,
  previousInteractionId?: string,
): Promise<EpisodeWizardSuggestionsResponse> {
  return generateText({
    systemInstruction: episodeWizardSystemInstruction(podcast, length, previousEpisodes, previousInteractionId !== undefined),
    prompt: buildEpisodeRevisePrompt(suggestions, targetSuggestionIndex, targetEpisodeIndex, instruction),
    schema: episodeWizardOptionsResponseSchema,
    ...(previousInteractionId ? { previousInteractionId } : {}),
  });
}

// A redraft has no suggestions to offer next, so the draft schema minus its
// "predictedChanges" (which would only cost output tokens).
export const episodeRedraftSchema = episodeDraftSchema.omit({ predictedChanges: true });
export type EpisodeRedraft = z.infer<typeof episodeRedraftSchema>;

/**
 * Drafts one existing episode again from its sources — see
 * episodeRedraftSystemInstruction. Like the wizard's drafts, it either carries
 * the earlier transcripts in its system instruction or continues the series'
 * stored interaction (`previousInteractionId`, see continuity.ts).
 */
export async function redraftEpisode(
  podcast: Podcast,
  episode: Episode,
  sources: Source[],
  previousEpisodes: PriorEpisode[],
  previousInteractionId?: string,
): Promise<EpisodeRedraft> {
  return generateText({
    systemInstruction: episodeRedraftSystemInstruction(podcast, episode, previousEpisodes, previousInteractionId !== undefined),
    prompt: buildEpisodeRedraftPrompt(episode, sources),
    schema: episodeRedraftSchema,
    ...(previousInteractionId ? { previousInteractionId } : {}),
  });
}
