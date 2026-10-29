import type { PriorEpisode } from "../../utils/episodeHistory";
import type { Podcast } from "../../schemas/podcast.schema";

function castNames(podcast: Podcast, { episode }: PriorEpisode): string {
  const hostNames = podcast.hosts
    .filter((host) => episode.participantHostIds.includes(host.id))
    .map((host) => host.name);
  const guestNames = episode.guests.map((guest) => `${guest.name} (guest)`);
  return [...hostNames, ...guestNames].join(", ");
}

const CONTINUITY_GUIDANCE = ` for continuity: the show is an ongoing series, so what was said, established, joked about, or \
left unresolved in earlier episodes is shared history for the hosts. Let it show naturally — a callback, a \
running joke, a follow-up on something promised, a consistent take on a recurring topic — but never contradict \
what an earlier episode established, and don't re-cover ground those episodes already covered in depth unless \
this episode's topics call for it. Don't recap earlier episodes unless the show's structure asks for it.`;

function formatTranscripts(previousEpisodes: PriorEpisode[], podcast: Podcast): string {
  return previousEpisodes
    .map((prior) => {
      const cast = castNames(podcast, prior);
      const header = `### Episode ${prior.number}: ${prior.episode.title}${cast ? ` (with ${cast})` : ""}`;
      return `${header}\n${prior.episode.transcript}`;
    })
    .join("\n\n");
}

/**
 * The earlier episodes' full transcripts, for continuity — shared by script
 * generation and the episode wizard so both reason from the same history.
 * Returns "" for a show with no prior episodes so callers can splice it in
 * unconditionally. Numbers are positions in the whole series, so a window of
 * the latest 15 out of 40 episodes still reads "Episode 26" … "Episode 40".
 */
export function buildEpisodeHistoryBlock(previousEpisodes: PriorEpisode[], podcast: Podcast): string {
  if (previousEpisodes.length === 0) return "";

  return `Previous episodes of this podcast, oldest first, with their full transcripts:

${formatTranscripts(previousEpisodes, podcast)}

Use these${CONTINUITY_GUIDANCE}`;
}

/**
 * The message of a catch-up call: it carries the earlier transcripts into the
 * conversation (so a chain can be rebuilt after an episode changed) and asks
 * for nothing but an acknowledgement. The guidance on how to use them comes
 * with the real call that continues from it (`buildChainedHistoryNote`).
 */
export function buildCatchUpPrompt(previousEpisodes: PriorEpisode[], podcast: Podcast): string {
  return `Previous episodes of this podcast, oldest first, with their full transcripts:

${formatTranscripts(previousEpisodes, podcast)}

These episodes are the history of the show so far; the next messages build on them. Reply with just "Understood."`;
}

/**
 * What stands in for the history block when the earlier episodes reach the
 * model through the conversation it continues (interaction context — see
 * services/episodeGeneration/continuity.ts) instead of being pasted into the
 * prompt. The guidance is the same text the block carries, so a chained call
 * is told how to use the history exactly as an unchained one is.
 */
export function buildChainedHistoryNote(): string {
  return `The earlier episodes of this podcast, oldest first, are already in this conversation, with the full \
script of each. Use them${CONTINUITY_GUIDANCE}`;
}
