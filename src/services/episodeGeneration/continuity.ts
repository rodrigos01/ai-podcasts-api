import { PreviousInteractionNotFoundError } from "../../llm/geminiClient";
import type { Podcast } from "../../schemas/podcast.schema";
import type { PriorEpisode } from "../../utils/episodeHistory";

/**
 * How a call (an episode's script, or a draft of the next episode) learns the
 * series so far. Exactly one of the two is ever set:
 *  - `previousEpisodes`: the earlier transcripts go in the prompt (the fallback);
 *  - `previousInteractionId`: the call continues the stored Interactions API
 *    interaction of the previous episode, which already holds the series so
 *    far, so nothing is sent a second time ("interaction context", on by
 *    default, turned off per podcast by `useInteractionContext: false`).
 */
export interface Continuity {
  previousEpisodes: PriorEpisode[];
  previousInteractionId?: string;
}

export function usesInteractionContext(podcast: Pick<Podcast, "useInteractionContext">): boolean {
  return podcast.useInteractionContext !== false;
}

/**
 * `prior` is the window of earlier episodes with transcripts, oldest first (see
 * utils/episodeHistory.ts). With interaction context the chain continues from
 * the most recent one's script interaction. If that episode has none (written
 * before the podcast switched, or generated outside the chain) the transcripts
 * go in the prompt instead, so switching a show over never loses its history.
 */
export function chooseContinuity(useInteractionContext: boolean, prior: PriorEpisode[]): Continuity {
  const head = prior[prior.length - 1]?.episode.interactionId;
  if (useInteractionContext && head) return { previousEpisodes: [], previousInteractionId: head };
  return { previousEpisodes: prior };
}

/**
 * Runs `run` with the continuity for this podcast. A stored interaction only
 * lives for a limited time (7 days by default), so when the chain's head is
 * gone (`PreviousInteractionNotFoundError`) the call is made again once with
 * the transcripts in the prompt instead of failing; the new interaction then
 * starts a fresh chain.
 */
export async function withContinuity<T>(
  podcast: Pick<Podcast, "useInteractionContext">,
  prior: PriorEpisode[],
  run: (continuity: Continuity) => Promise<T>,
): Promise<T> {
  const continuity = chooseContinuity(usesInteractionContext(podcast), prior);
  if (!continuity.previousInteractionId) return run(continuity);
  try {
    return await run(continuity);
  } catch (err) {
    if (!(err instanceof PreviousInteractionNotFoundError)) throw err;
    console.warn(`${err.message}; falling back to the transcripts in the prompt.`);
    return run({ previousEpisodes: prior });
  }
}
