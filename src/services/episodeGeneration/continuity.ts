import { MAX_HISTORY_EPISODES } from "../../constants/episodeHistory";
import { getPriorEpisodes } from "../../data/episode.repository";
import type { Episode } from "../../schemas/episode.schema";
import type { HistoryMethod, Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import type { PriorEpisode } from "../../utils/episodeHistory";
import { generatePastNotes } from "./pastNotes.service";

export interface ScriptContinuity {
  /** Earlier transcripts to put in the prompt ("transcripts" method); empty otherwise. */
  previousEpisodes: PriorEpisode[];
  /** The interaction to continue ("interaction" method); undefined otherwise. */
  previousInteractionId?: string;
  /** Notes about earlier episodes ("notes" method); undefined otherwise or for a first episode. */
  pastNotes?: string;
}

export function historyMethodOf(podcast: Podcast): HistoryMethod {
  return podcast.historyMethod ?? "transcripts";
}

/**
 * How an episode's script call learns the series so far, per the podcast's
 * `historyMethod`. Whichever it is, it sees only the episodes strictly before
 * this one in series order, so regenerating an old episode never sees later ones.
 *
 * - "transcripts" (default): the full transcripts of up to MAX_HISTORY_EPISODES
 *   earlier episodes go in the system instruction.
 * - "interaction": the call continues the stored interaction of the episode
 *   immediately before this one; an episode with no predecessor, or whose
 *   predecessor has no interaction id, starts fresh.
 * - "notes": the same transcripts go to an intermediary call that writes notes
 *   relevant to this episode (pastNotes.service.ts); only the notes reach the
 *   script call.
 */
export async function resolveScriptContinuity(
  podcast: Podcast,
  episode: Episode,
  sources: Source[],
): Promise<ScriptContinuity> {
  const anchor = { id: episode.id, createdAt: episode.createdAt };
  switch (historyMethodOf(podcast)) {
    case "interaction": {
      const [previous] = await getPriorEpisodes(podcast.id, anchor, 1);
      const previousInteractionId = previous?.episode.interactionId ?? undefined;
      return { previousEpisodes: [], ...(previousInteractionId ? { previousInteractionId } : {}) };
    }
    case "notes": {
      const prior = await getPriorEpisodes(podcast.id, anchor, MAX_HISTORY_EPISODES);
      const pastNotes = await generatePastNotes(podcast, episode, sources, prior);
      return { previousEpisodes: [], ...(pastNotes ? { pastNotes } : {}) };
    }
    case "transcripts":
      return { previousEpisodes: await getPriorEpisodes(podcast.id, anchor, MAX_HISTORY_EPISODES) };
  }
}
