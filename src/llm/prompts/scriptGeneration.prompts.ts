import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import { speakerLabel, type Cast, type Speaker } from "../../services/episodeGeneration/speakerSelection";

export interface ScriptGenerationContext {
  podcast: Podcast;
  episode: Episode;
  sources: Source[];
}

export interface WordTarget {
  min: number;
  max: number;
}

export function sourceBlock(sources: Source[]): string {
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
  const hosts = ctx.podcast.hosts.map((h) => `${h.name}: ${h.persona}`).join("\n");

  return `You are a script writer for a podcast called "${ctx.podcast.title}". The podcast premise is as follows:
"${ctx.podcast.description}"
And episodes follow this structure:
${ctx.podcast.structure}

The show host(s) are:
${hosts}


The scripts will be used with a TTS engine, and follow this format:

${labelA}: line
(Optional) Style: delivery directions for that turn

${labelB}: line
...

Speaker labels must be exactly "${labelA}" and "${labelB}", character for character — they are matched \
literally to assign voices. Every turn must contain spoken words, and a Style line, when used, goes on its \
own line after the spoken words.

Each "[speaker]: line" pair is a turn. Keep turns short, like in real conversation. One or two sentences \
to keep them from becoming monologues. If you need to write longer lines, don't try to hack it by \
splitting them across multiple sequential turns from the same speaker, or having the other speaker \
complete those with their own lines. Instead, break longer turns down into multiple ones with comments \
and reactions from the other speaker in between. Very short reaction turns work best as backchanneling (see below).

Keep the different speakers as their own individuals, avoiding them sounding like a single entity speaking in \
turn or completing each other's sentences. If it makes sense for the speakers personas to disagree, they should. \
If the speakers have explicitly different roles, such as host and guest, make sure they stick to their roles, unless \
breaking character is a key part of the conversation.

You can use the following tags to make the conversation more realistic:

- Non vocal bursts: use instructions in angle brackets such as <laughs> or <gasps> to introduce these non \
spoken sounds in the speaker's turn.
- Backchanneling: if you want the *other* speaker to say a quick reaction or interject to what's been spoken, \
overlapping with the active speaker, you can inject those using pipes like |hm| or |yes| in the active speaker's \
turn. There's no limit to what can be injected, but it overlaps with the active speaker so keep it brief for \
intelligibility.
For Example: 
  ${labelA}: I think the most important part of the story is what they didn't say. |How so?| Because it's not just what's seen. It's what's felt.
Will be rendered by the TTS engine as:
  ${labelA}: I think the most important part of the story is what they didn't say. 
  ${labelB}: How so? 
  ${labelA}: Because it's not just what's seen. It's what's felt.

The following rules must be followed:
- When citing sources, never invent details like names, places, dates or specific facts to fill in gaps. Translations can be adapted (see below).
- Always write numbers as words, so that it can be pronounced correctly.
- If citing sources in a different language from the script, make a best effort to adapt them so that they \
sound natural for the target language's audience, instead of always translating them literally, while keeping the original intent.
- |backchanneling| should NEVER appear as the first or last spoken sentence in a turn. This tool should only \
be used mid-turn to inject speech with the OTHER speaker's voice, and IS NOT meant for adding emphasis to the \
active speaker's turn.
`;
}

export function buildScriptGenerationPrompt(cast: Cast, ctx: ScriptGenerationContext, wordTarget: WordTarget): string {
  const minutes = Math.round((wordTarget.min + wordTarget.max) / 2 / WORDS_PER_MINUTE);
  const guest = cast.speakers.find((s) => !s.isHost);
  const guestBlock = guest
    ? `\n\nThe guest for this episode is ${guest.name} and here's their bio: ${guest.persona}`
    : "";
  const draft = `Title: ${ctx.episode.title}\nTopics: ${ctx.episode.topics}${ctx.episode.productionNotes ? `\nProduction notes: ${ctx.episode.productionNotes}` : ""
    }`;

  return `Write the script for an episode based on the sources below, following this draft:
${draft}${guestBlock}

The script *must* have between ${wordTarget.min}-${wordTarget.max} words (for a ~${minutes}m episode).

Sources:
${sourceBlock(ctx.sources)}`;
}
