import type { Episode } from "../schemas/episode.schema";

/**
 * Whether an episode needs its continuity notes (re)written by the notes-only
 * call before its script is generated:
 *  - one with no notes (drafted before notes existed, by a client that didn't
 *    send them, or whose draft found nothing to carry over) gets them written
 *    so a regenerate doesn't lose the series;
 *  - a later part of a split always gets them rewritten, because the draft was
 *    made before the part before it had a transcript.
 * Either way there has to be an earlier episode with a transcript to read.
 */
export function needsContinuityNotes(
  episode: Pick<Episode, "continuityNotes" | "startsAfterEpisodeId">,
  priorEpisodeCount: number,
): boolean {
  if (priorEpisodeCount === 0) return false;
  return !episode.continuityNotes || Boolean(episode.startsAfterEpisodeId);
}
