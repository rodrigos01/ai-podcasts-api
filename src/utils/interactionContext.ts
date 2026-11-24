import type { Podcast } from "../schemas/podcast.schema";

/**
 * Whether a podcast's calls continue the series' stored Interactions API
 * interaction (the default) instead of working from continuity notes: only an
 * explicit `useInteractionContext: false` opts out. See
 * services/episodeGeneration/continuity.ts.
 */
export function usesInteractionContext(podcast: Pick<Podcast, "useInteractionContext">): boolean {
  return podcast.useInteractionContext !== false;
}
