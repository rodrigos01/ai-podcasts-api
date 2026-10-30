import { z } from "zod";
import { generateText } from "../../llm/geminiClient";
import { continuityNotesPrompt, continuityNotesSystemInstruction } from "../../llm/prompts/continuityNotes.prompts";
import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import type { PriorEpisode } from "../../utils/episodeHistory";

const continuityNotesResponseSchema = z.object({ continuityNotes: z.string() });

/**
 * Writes the continuity notes for an already-drafted episode from the earlier
 * transcripts (the notes-only call). Resolves to undefined when the model finds
 * nothing to carry over.
 */
export async function writeContinuityNotes(
  podcast: Podcast,
  episode: Episode,
  sources: Source[],
  previousEpisodes: PriorEpisode[],
): Promise<string | undefined> {
  const { continuityNotes } = await generateText({
    systemInstruction: continuityNotesSystemInstruction(podcast, previousEpisodes),
    prompt: continuityNotesPrompt(episode, sources),
    schema: continuityNotesResponseSchema,
  });
  return continuityNotes.trim() || undefined;
}
