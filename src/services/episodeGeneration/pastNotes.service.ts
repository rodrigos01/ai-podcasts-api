import { generatePlainText } from "../../llm/geminiClient";
import { PAST_NOTES_SYSTEM_INSTRUCTION, buildPastNotesPrompt } from "../../llm/prompts/pastNotes.prompts";
import { getSource } from "../../data/source.repository";
import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import type { PriorEpisode } from "../../utils/episodeHistory";

/**
 * The intermediary call of the "notes" history method: reads the full
 * transcripts (and sources) of the earlier episodes and writes an inventory of
 * what's relevant to the upcoming episode, which script generation then gets in
 * place of the transcripts. Returns null for an episode with no earlier
 * episodes, where there is nothing to write notes about.
 */
export async function generatePastNotes(
  podcast: Podcast,
  upcoming: Episode,
  upcomingSources: Source[],
  priorEpisodes: PriorEpisode[],
): Promise<string | null> {
  if (priorEpisodes.length === 0) return null;

  const sourceIds = [...new Set(priorEpisodes.flatMap(({ episode }) => episode.sourceIds))];
  const priorSources = new Map<string, Source>();
  for (const source of await Promise.all(sourceIds.map((id) => getSource(podcast.id, id)))) {
    if (source) priorSources.set(source.id, source);
  }

  const { text } = await generatePlainText({
    systemInstruction: PAST_NOTES_SYSTEM_INSTRUCTION,
    prompt: buildPastNotesPrompt(podcast, upcoming, upcomingSources, priorEpisodes, priorSources),
    thinkingLevel: "medium",
  });
  return text.trim();
}
