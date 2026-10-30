import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import type { PriorEpisode } from "../../utils/episodeHistory";
import { buildEpisodeHistoryBlock } from "./episodeHistory.prompts";
import { CONTINUITY_NOTES_SECTION, sourceBlock } from "./episodeWizard.prompts";

/**
 * The notes-only call: writes the continuity notes of an episode that already
 * has its draft, from the earlier transcripts. It follows the very same rules
 * the episode wizard's draft call is given (CONTINUITY_NOTES_SECTION), so the
 * notes read the same whichever call wrote them.
 */
export function continuityNotesSystemInstruction(podcast: Podcast, previousEpisodes: PriorEpisode[]): string {
  const hosts = podcast.hosts.map((h) => `${h.name} (persona: ${h.persona})`).join("; ");
  return `You are the producer for the podcast "${podcast.title}".

Podcast description: ${podcast.description}

Podcast structure:
${podcast.structure}

Fixed hosts on this show: ${hosts}

${buildEpisodeHistoryBlock(previousEpisodes, podcast)}

The episode below has already been drafted. Your only job is to write its continuity notes.${CONTINUITY_NOTES_SECTION}`;
}

export function continuityNotesPrompt(episode: Episode, sources: Source[]): string {
  const guest = episode.guests[0];
  return `Pre-production source material for this episode:

${sourceBlock(sources)}

The drafted episode:
Title: ${episode.title}
Topics: ${episode.topics}${episode.productionNotes ? `\nProduction notes: ${episode.productionNotes}` : ""}${
    guest ? `\nGuest: ${guest.name}: ${guest.persona}` : ""
  }

Write the "continuityNotes" for this episode, following the continuity notes rules above. Return an empty string if no earlier moment bears on it and there is no show formula to carry.`;
}
