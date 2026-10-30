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
/**
 * The podcast's user-written extra instructions as a prompt section (blank
 * lines around it), or "" when unset. Shared by the script writer and the
 * episode wizard so both read them the same way.
 */
export function extraInstructionsSection(extraInstructions: string | undefined): string {
  const text = extraInstructions?.trim();
  if (!text) return "";
  return `
Extra instructions from the show's creator, to follow on top of the description and structure above when \
writing or drafting episodes (where they conflict, these win):
${text}
`;
}

export function buildEpisodeHistoryBlock(previousEpisodes: PriorEpisode[], podcast: Podcast): string {
  if (previousEpisodes.length === 0) return "";

  return `Previous episodes of this podcast, oldest first, with their full transcripts:

${formatTranscripts(previousEpisodes, podcast)}

Use these${CONTINUITY_GUIDANCE}`;
}

/**
 * The continuity notes that stand in for the history in a script call of a
 * podcast on continuity notes: the draft call already picked what from the
 * earlier episodes bears on this one, so that is all the writer sees. "" when
 * the draft had nothing to carry over.
 */
export function buildContinuityNotesBlock(notes: string | undefined): string {
  if (!notes) return "";
  return `Continuity notes from the earlier episodes of this podcast (the episodes themselves are not shown; \
these notes hold only what bears on this episode):

${notes}

Treat the details in these notes as exact: they are what the earlier episodes established, so don't change \
them. Where the notes give the show's formula (opening and closing lines, sign-offs, segment names, rituals), \
follow it as written. Use these notes${CONTINUITY_GUIDANCE}`;
}
