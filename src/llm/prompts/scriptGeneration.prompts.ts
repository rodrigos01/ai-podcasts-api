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
  const speakerBlocks = cast.speakers.map((s) => speakerBlock(s, ctx)).join("\n\n");

  return `You are writing the complete script for one episode of the podcast "${ctx.podcast.title}", \
playing BOTH speakers below yourself — not just one of them.

Podcast description: ${ctx.podcast.description}

Podcast structure (how episodes of this show are built):
${ctx.podcast.structure}

This episode's topics: ${ctx.episode.topics}

Production notes for this episode: ${ctx.episode.productionNotes}

The two speakers in this episode:
${speakerBlocks}

Pre-production source material for this episode:
${sourceBlock(ctx.sources)}

Even though you are authoring both sides of the conversation, keep ${a.name} and ${b.name} as fully \
independent individuals. Each of them only knows their own persona and background, plus whatever has \
actually been said aloud so far in the conversation — never let one of them react to, reference, or build \
on something the other hasn't actually said out loud, even though you (the writer) already know it. Give \
them distinct voices and opinions: they should react naturally, disagree when it fits their persona, and \
not simply agree with everything the other says.

Real conversation is uneven in length and rhythm, not a series of balanced statements. Most turns should \
be short — as brief as a single reaction, a short interjection, or a partial thought — rather than a full \
explanation, even when a speaker has more to say. A speaker can also leave something deliberately \
unfinished: naming that something happened, or hinting at an opinion, without immediately explaining it, \
so the other speaker has to ask them to go on. A longer, fuller turn is fine when it's genuinely earned, \
but it should be the exception, not the default. You control how many turns each beat of the conversation \
takes — you don't have to alternate strictly or give both speakers equal airtime turn by turn.

Don't have every turn end with a question. Real conversational partners mostly react, state an opinion, \
add their own angle, or just let a point land — they don't interview each other. An occasional question is \
natural and welcome when it's genuinely what the moment calls for, but if a turn is about to ask something \
just to keep the other person talking, make it something substantive instead. The one exception is if this \
show's format (see the structure/production notes above) specifically calls for one speaker to interview \
the other — follow that format if so.

You may include short bracketed delivery cues inline (e.g. [laughs], [thoughtful pause], [sighs], \
[excitedly]) where they help a text-to-speech performer read a line naturally — but don't overuse them.

Every line is fed directly to a text-to-speech model, not displayed as text — so write it as plain, clean \
spoken language, with no markdown formatting of any kind: no **bold**/*italics*, no # headers, no bullet \
or numbered lists, no inline-code formatting, no [links](url). The TTS model has no concept of markdown \
styling — it reads those characters as literal spoken words, which will ruin the line. Bracketed delivery \
cues (above) are the one exception, since the TTS model is specifically built to read those as performance \
direction, not literal text.

Never start any line, or any sentence within a line, with a short word or phrase immediately followed by a \
colon, like "Watch this: ..." or "Funny thing: ...". The system that parses your output reads anything \
shaped like "Word:" at the very start of a line as a change of speaker, and it will scramble turn \
attribution. If you want that kind of framing, phrase it without the colon instead (e.g. "Watch this —" or \
"Funny thing, actually,").

## Output format — this feeds Gemini TTS's multi-speaker synthesis directly, exactly as you write it

Write the entire episode as a sequence of turns in this exact format, one turn per block, separated by a \
single blank line:

${labelA}: <the line ${a.name} speaks>

${labelB}: <the line ${b.name} speaks>

The ONLY two valid labels, spelled and capitalized exactly like this, are "${labelA}" and "${labelB}" — \
use each one's first name alone (not their full name, a nickname, or a title) at the start of every single \
turn, with nothing else on that line before the colon. This is a strict format requirement, not a style \
preference: the system reading your output matches turn labels byte-for-byte against these two exact \
strings to route each line to the correct voice, so any other form (a full name, a shortened or misspelled \
version, a different capitalization) will make that turn's line fail to reach the right voice.

Respond with ONLY the transcript itself in that format — no preamble, no headers, no commentary before or \
after it.`;
}

export function buildScriptGenerationPrompt(cast: Cast, wordTarget: WordTarget): string {
  const [a, b] = cast.speakers;
  const kickoff = cast.speakers.find((s) => s.id === cast.kickoffSpeakerId) ?? a;
  const other = cast.speakers.find((s) => s.id !== kickoff.id) ?? b;
  const kickoffLabel = speakerLabel(kickoff.name, other.name);

  return `${kickoffLabel} opens the episode, following the podcast's structure and this episode's \
production notes — there is no prior conversation before this.

The whole episode should land between ${wordTarget.min} and ${wordTarget.max} spoken words in total. Pace \
and structure the conversation so it naturally lands in this range: don't pad it out if the material runs \
short, and don't let it sprawl past the maximum if the material runs long — bring the conversation to a \
natural close once the topics have been covered well, even if you're tempted to keep going.

Write the full episode now, in the "Name: line" format described above.`;
}
