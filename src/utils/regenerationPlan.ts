import { compareBySeriesOrder } from "./episodeHistory";

export interface PlannedRegeneration {
  id: string;
  /** The selected episode that must finish first; none for the first one. */
  startsAfterEpisodeId?: string;
}

/**
 * The order to regenerate a set of episodes in: series order, one after the
 * other, because each episode's script is written with the transcripts of the
 * ones before it as history — so an earlier one has to be done (and its new
 * transcript stored) before a later one starts.
 */
export function planRegeneration(episodes: { id: string; createdAt: number }[]): PlannedRegeneration[] {
  return [...episodes].sort(compareBySeriesOrder).map((episode, index, sorted) => {
    const previous = sorted[index - 1];
    return { id: episode.id, ...(previous ? { startsAfterEpisodeId: previous.id } : {}) };
  });
}
