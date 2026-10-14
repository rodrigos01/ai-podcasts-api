import { MAX_HISTORY_EPISODES } from "../../constants/episodeHistory";
import { getPriorEpisodes } from "../../data/episode.repository";
import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { PriorEpisode } from "../../utils/episodeHistory";

export interface ScriptContinuity {
  /** Earlier transcripts to put in the prompt (manual history); empty on interaction context. */
  previousEpisodes: PriorEpisode[];
  /** The interaction to continue (interaction context); undefined on manual history. */
  previousInteractionId?: string;
}

/**
 * How an episode's script call learns the series so far, per the podcast's
 * `useInteractionContext` flag. Either way it sees only the episodes strictly
 * before it in series order, so regenerating an old episode never sees later ones.
 *
 * - Manual history (default): the transcripts of up to MAX_HISTORY_EPISODES
 *   earlier episodes go in the system instruction.
 * - Interaction context: the call continues the stored interaction of the
 *   episode immediately before this one; an episode with no predecessor, or
 *   whose predecessor has no interaction id, starts fresh.
 */
export async function resolveScriptContinuity(podcast: Podcast, episode: Episode): Promise<ScriptContinuity> {
  const anchor = { id: episode.id, createdAt: episode.createdAt };
  if (podcast.useInteractionContext === true) {
    const [previous] = await getPriorEpisodes(podcast.id, anchor, 1);
    const previousInteractionId = previous?.episode.interactionId ?? undefined;
    return { previousEpisodes: [], ...(previousInteractionId ? { previousInteractionId } : {}) };
  }
  return { previousEpisodes: await getPriorEpisodes(podcast.id, anchor, MAX_HISTORY_EPISODES) };
}
