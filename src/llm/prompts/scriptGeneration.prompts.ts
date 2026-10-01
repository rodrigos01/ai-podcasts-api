import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import { speakerLabel, type Cast, type Speaker } from "../../services/episodeGeneration/speakerSelection";

export interface ScriptGenerationContext {
  podcast: Podcast;
  episode: Episode;
  sources: Source[];
  /** Only ever populated for hosts — condensed continuity from past episodes they were in. */
  condensedHistoryBySpeakerId: Map<string, string>;
}

export interface WordTarget {
  min: number;
  max: number;
}

function sourceBlock(sources: Source[]): string {
  if (sources.length === 0) return "(no source material was provided for this episode)";
  return sources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n");
}

function speakerBlock(speaker: Speaker, ctx: ScriptGenerationContext): string {
  const roleLine = speaker.isHost
    ? `${speaker.name} — a host of the podcast "${ctx.podcast.title}".`
    : `${speaker.name} — a guest on this episode of the podcast "${ctx.podcast.title}".`;
  const history = ctx.condensedHistoryBySpeakerId.get(speaker.id);
  const historyBlock = history ? `\nWhat ${speaker.name} remembers from past episodes:\n${history}` : "";
  return `${roleLine}\nPersona: ${speaker.persona}${historyBlock}`;
}

/**
 * A single system instruction that writes BOTH speakers' lines itself —
 * replaces the old per-speaker `buildAgentSystemInstruction` (hostPersona.prompts.ts),
 * which gave each of two independent LLM calls its own private instruction.
 * This is a deliberate architectural tradeoff (see AGENTS.md's migration
 * note): a single writer can no longer structurally guarantee each speaker
 * only knows their own material the way per-agent isolation + per-speaker
 * source partitioning did — the instruction below asks for that behavior,
 * it doesn't enforce it.
 */
export function buildScriptSystemInstruction(
  cast: Cast,
  ctx: ScriptGenerationContext,
): string {
  const [a, b] = cast.speakers;
  const labelA = speakerLabel(a.name, b.name);
  const labelB = speakerLabel(b.name, a.name);

  return `You are a scriptwriter for the podcast "${ctx.podcast.title}".

Podcast description: ${ctx.podcast.description}

Podcast structure (how episodes of this show are built):
${ctx.podcast.structure}

The Scripts you write should strictly follow this formatting:
${labelA}: "line 1"
Style: (Optional) additional instructions for the TTS engine

${labelB}: "line 1"
Style: (Optional)

Keep turns short, like in normal conversation, avoiding long monologues or explanatory \
deliveries, unless the topics or personas ask for that. Also avoid ending every turn with \
a question, unless it's a rhetorical question or it naturally fits the conversation, or \
if the podcast is structured as an interview with the hosts asking questions. 

The scripts will be read by a text-to-speech engine which infers tone and intonation \
out of the box, based on each speaker's persona.

Use these tools to add realism to the speaker's turns:

* Non-speech sounds and vocal bursts: You can use tags in angle brackets mid-sentence to direct the TTS engine to produce non-vocal sounds like <laughs>, <sighs>, <chuckles>, <pauses for thought>, <clears throat>, etc.
* Pacing and pauses: use punctuation like commas, dashes (--), and ellipses (...) for natural conversational hesitation.
* Turn-level style direction: You can add a style line directly after the speaker line to direct how the entire turn should be delivered. Those are optional and often not necessary. Most lines work best without it. Prefer to use it when there is a significant tone or delivery shift that isn't captured by the persona alone.
* Emphasis: Capitalize specific words in the transcript, combined with punctuation and inline vocal tags, to place natural vocal stress on key words
* Mid-turn interjections: The engine supports introducing short interjections from the other speaker 
within the current speaker's turn. Use this to make the conversation sound more natural 
and engaging.

Examples:

* Style lines: The following example instructs TTS to deliver this line as a sarcastic deadpan:
  * ${labelA}: "I Am the most important person in this room."
  Style: deadpan, sarcastic.

* Backchanneling: The following example instructs TTS to deliver "I have no Idea" with ${labelB}'s voice in the middle of ${labelA}'s line:
  * ${labelA}: "Do you know what they did? |I have no idea| They shut down the entire project!"
  

You should also folow these rules, failing to adhere to those will break the TTS engine delivery:
1. Every turn must have spoken words. There should be no empty turns or turns with just \
non-vocal tags or backchanneling.
2. Style lines, when present, should always come after the spoken words on a new line.
3. Formatting tags like asterisks for emphasis should never be used, as they will \
be read out loud by the TTS engine. Quotation should only be used when the speaker is \
quoting something, like a piece of the source matrial. Do not wrap the entire line in \
quotation marks.
4. Turns should never start with backchanneling tags. It's meant as a \
reaction to what the speaker is saying, so it needs the active speaker to have said something first. 
`
}

export function buildScriptGenerationPrompt(cast: Cast, ctx: ScriptGenerationContext, wordTarget: WordTarget): string {
  const [a, b] = cast.speakers;
  const speakerBlocks = cast.speakers.map((s) => speakerBlock(s, ctx)).join("\n\n");
  const kickoff = cast.speakers.find((s) => s.id === cast.kickoffSpeakerId) ?? a;
  const other = cast.speakers.find((s) => s.id !== kickoff.id) ?? b;
  const kickoffLabel = speakerLabel(kickoff.name, other.name);

  return `
 Write the script for a new episode of the podcast. You should write the lines \
for both podcasts speakers as a natural, engaging, and interesting conversation, following \
the podcast structure and this episode's production notes. Format this script strictly with the \
Name: Line\nStyle: ... format described above.

This episode's topics: ${ctx.episode.topics}

Production notes for this episode: ${ctx.episode.productionNotes}

The two speakers in this episode are:
${speakerBlocks}
Keep their lines consistent with their personas and backgrounds. If their personalities or \
views clash, let them have a conversation about it, disagreeing and challenging each other.

Pre-production source material for this episode:
${sourceBlock(ctx.sources)}

  ${kickoffLabel} opens the episode, following the podcast's structure and this episode's \
production notes — there is no prior conversation before this.

The whole episode should land between ${wordTarget.min} and ${wordTarget.max} spoken words in total. Pace \
and structure the conversation so it naturally lands in this range: don't pad it out if the material runs \
short, and don't let it sprawl past the maximum if the material runs long — bring the conversation to a \
natural close once the topics have been covered well, even if you're tempted to keep going.`;
}

