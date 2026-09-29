import type { Episode } from "../schemas/episode.schema";

export interface EpisodeAnchor {
  id: string;
  createdAt: number;
}

export function compareBySeriesOrder(a: EpisodeAnchor, b: EpisodeAnchor): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The up-to-`limit` episodes that come strictly *before* `anchor` in series
 * order (`createdAt`, then `id` as a tiebreaker — a confirmed 2-part split
 * creates both episodes in the same loop, so equal timestamps are possible),
 * oldest first. With no anchor (a brand-new episode that doesn't exist yet),
 * that's simply the latest `limit` episodes. `createdAt` never changes on
 * regeneration, so regenerating episode N sees N-limit..N-1 rather than
 * whatever happens to be newest. Only episodes that actually have a
 * transcript count — a mid-generation or never-scripted episode has nothing
 * to give as continuity.
 */
export function selectPriorEpisodes(
  episodes: Episode[],
  anchor: EpisodeAnchor | undefined,
  limit: number,
): Episode[] {
  return episodes
    .filter(
      (episode) =>
        episode.transcript !== null &&
        (anchor === undefined || compareBySeriesOrder(episode, anchor) < 0),
    )
    .sort(compareBySeriesOrder)
    .slice(-limit);
}

export interface PriorEpisode {
  /** 1-based position in the whole series (including episodes without a transcript). */
  number: number;
  episode: Episode;
}
