import type { PriorEpisode } from "../../utils/episodeHistory";
import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import { buildEpisodeHistoryBlock } from "./episodeHistory.prompts";
import { speakerLabel, type Cast, type Speaker } from "../../services/episodeGeneration/speakerSelection";

export interface ScriptGenerationContext {
  podcast: Podcast;
  episode: Episode;
  sources: Source[];
  /** Earlier episodes' transcripts, oldest first — see episodeHistory.prompts.ts. */
  previousEpisodes: PriorEpisode[];
}

export interface WordTarget {
  min: number;
  max: number;
}

function sourceBlock(sources: Source[]): string {
  if (sources.length === 0) return "(no source material was provided for this episode)";
  return sources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n");
}

// Rough conversational speech rate, used only to tell the writer what episode
// duration its word target corresponds to.
const WORDS_PER_MINUTE = 155;

/**
 * A single system instruction that writes BOTH speakers' lines itself —
 * see AGENTS.md's migration note: a single writer can't structurally keep
 * each speaker's knowledge separate; the prompt only asks for it.
 */
export function buildScriptSystemInstruction(
  cast: Cast,
  ctx: ScriptGenerationContext,
): string {
  const [a, b] = cast.speakers;
  const labelA = speakerLabel(a.name, b.name);
  const labelB = speakerLabel(b.name, a.name);
  const history = buildEpisodeHistoryBlock(ctx.previousEpisodes, ctx.podcast);
  const historySection = history ? `\n\n${history}` : "";
  const hosts = ctx.podcast.hosts.map((h) => `${h.name}: ${h.persona}`).join("\n");

  return `You are a script writer for a podcast called "${ctx.podcast.title}". The podcast premise is as follows:
"${ctx.podcast.description}"
And episodes follow this structure:
${ctx.podcast.structure}

The show host(s) are:
${hosts}${historySection}

The scripts will be used with a TTS engine, and follow this format:

${labelA}: line
(Optional) Style: delivery directions for that turn

${labelB}: line
...

Speaker labels must be exactly "${labelA}" and "${labelB}", character for character — they are matched \
literally to assign voices. Every turn must contain spoken words, and a Style line, when used, goes on its \
own line after the spoken words.

Keep turns short, like in real conversation. One or two sentences to keep them from becoming monologues. \
Very short reaction turns work best as backchanneling (see below).

You can use the following tags to make the conversation more realistic:

- Non vocal bursts: use instructions in angle brackets such as <laughs> or <gasps> to introduce these non spoken sounds in the speaker's turn.
- Backchanneling: if you want the *other* speaker to say a quick reaction or interjection to what's been spoken, overlapping with the active speaker, you can inject those using pipes like |hm| or |yes|. There's no limit to what can be injected, but it overlaps with the active speaker so keep it brief for intelligibility.
`;
}

export function buildScriptGenerationPrompt(cast: Cast, ctx: ScriptGenerationContext, wordTarget: WordTarget): string {
  const minutes = Math.round((wordTarget.min + wordTarget.max) / 2 / WORDS_PER_MINUTE);
  const guest = cast.speakers.find((s) => !s.isHost);
  const guestBlock = guest
    ? `\n\nThe guest for this episode is ${guest.name} and here's their bio: ${guest.persona}`
    : "";
  const draft = `Title: ${ctx.episode.title}\nTopics: ${ctx.episode.topics}\nProduction notes: ${ctx.episode.productionNotes}`;

  return `Write the script for an episode based on the sources below, following this draft:
${draft}${guestBlock}

The script should have between ${wordTarget.min}-${wordTarget.max} words (for a ~${minutes}m episode).

Sources:
${sourceBlock(ctx.sources)}`;
}
