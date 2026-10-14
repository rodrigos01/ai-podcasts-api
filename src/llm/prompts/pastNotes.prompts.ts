import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import type { PriorEpisode } from "../../utils/episodeHistory";

function castLine(podcast: Podcast, episode: Episode): string {
  const hosts = podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id)).map((h) => `${h.name} (host)`);
  const guests = episode.guests.map((g) => `${g.name} (guest)`);
  return [...hosts, ...guests].join(", ");
}

export const PAST_NOTES_SYSTEM_INSTRUCTION = `You compile reference notes for a script writer who is about to write the next \
episode of an ongoing podcast. You are given the full transcripts of the earlier episodes, the source material \
those episodes were built from, and a description of the upcoming episode. Write "Relevant notes from past \
episodes": an inventory of everything in the earlier episodes that could be relevant to writing the upcoming one.

The notes are a list of things to know, nothing more:
- Report, don't direct. Do not tell the script writer what to do, include, avoid, call back to, or how to \
structure or angle the episode, and do not suggest ideas. Avoid "should", "consider", "make sure", "callback" \
and the like. State what is the case.
- Every item says which episode it comes from (by number, e.g. "Episode 3") and is attributed to the right \
origin: a specific host or guest by name (who said it, did it, claimed it, or experienced it), or the source \
material (what the source journal or document itself says, as opposed to what a host said about it). Never \
credit a person with something that came from the source, or the source with something a person said, and \
never merge two people's statements. A speaker's statement is a statement, not a verified fact: write "Penny \
said ..." rather than presenting it as established truth.
- Stay faithful to the material. Include only what the transcripts and sources actually contain, with no \
inference or embellishment. Quote the exact wording when the wording itself matters, such as the name and \
definition of a recurring segment or scoring scale, a running joke's phrasing, or a promise someone made.
- Be thorough about what is relevant, and leave out what isn't. Relevant includes: facts established about \
each host and guest (background, opinions, preferences, personal details, and what they have said about \
themselves or each other); recurring segments, formats and conventions as they have actually been used; running \
jokes and phrases; things promised, asked, or left open, and whether any later episode picks them up; places, \
people, events or topics that also appear in the upcoming episode's topics or sources, with what was already \
said about them and in how much depth; the previous episode's final moments if the upcoming one follows \
directly; and stories that continue across episodes. Do not write episode-by-episode recaps or summaries.
- Format: plain text, grouped under short headings, with each item as a bullet. Output only the notes, with no \
preamble or closing remarks.`;

/** The user message for the notes call: everything it needs to judge what's relevant. */
export function buildPastNotesPrompt(
  podcast: Podcast,
  upcoming: Episode,
  upcomingSources: Source[],
  priorEpisodes: PriorEpisode[],
  priorSources: Map<string, Source>,
): string {
  const upcomingSourceIds = new Set(upcomingSources.map((s) => s.id));

  const transcripts = priorEpisodes
    .map(({ number, episode }) => {
      const sourceTitles = episode.sourceIds.map((id) => priorSources.get(id)?.title).filter(Boolean);
      const sources = sourceTitles.length ? `\nSource material used: ${sourceTitles.map((t) => `"${t}"`).join(", ")}` : "";
      return `### Episode ${number}: ${episode.title}\nCast: ${castLine(podcast, episode)}${sources}\n\n${episode.transcript}`;
    })
    .join("\n\n");

  // A source the upcoming episode also uses is printed once, under the upcoming episode.
  const pastOnlySources = [...priorSources.values()].filter((s) => !upcomingSourceIds.has(s.id));
  const pastSourcesBlock = pastOnlySources.length
    ? pastOnlySources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n")
    : "(none beyond the sources of the upcoming episode)";

  const upcomingSourcesBlock = upcomingSources.length
    ? upcomingSources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n")
    : "(no source material was provided for this episode)";

  const notes = upcoming.productionNotes ? `\nProduction notes: ${upcoming.productionNotes}` : "";

  return `Podcast: "${podcast.title}"
${podcast.description}

# Earlier episodes, oldest first

${transcripts}

# Source material used by earlier episodes
(Sources that the upcoming episode also uses are printed in full under the upcoming episode below.)

${pastSourcesBlock}

# The upcoming episode

Title: ${upcoming.title}
Cast: ${castLine(podcast, upcoming)}
Topics: ${upcoming.topics}${notes}

Its source material:

${upcomingSourcesBlock}

Write the relevant notes from the earlier episodes now.`;
}

/** The section of the script writer's system instruction that carries the notes. */
export function buildPastNotesBlock(notes: string): string {
  return `Relevant notes from past episodes of this podcast:

${notes}

These notes are an inventory of information from earlier episodes that might be relevant to this one, \
compiled by an assistant. They are not a checklist and not instructions: nothing in them needs to be called \
back, mentioned, followed up on, or avoided. Treat them as background knowledge of the show's shared history, \
and draw on an item only where it naturally serves this episode. Never contradict what the earlier episodes \
established, and don't recap them unless the show's structure asks for it. The notes can be incomplete, so \
don't assume an item's absence means something didn't happen.`;
}
