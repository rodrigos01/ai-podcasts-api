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
independent individuals: each only knows their own persona and background, plus whatever has actually been \
said aloud so far — never let one react to, reference, or build on something the other hasn't actually said \
out loud, even though you (the writer) already know it. Give them distinct voices and opinions; they should \
disagree when it fits their persona rather than simply agreeing with everything the other says.

## Pacing

Real conversation is uneven, not a series of balanced statements. Most turns should be short — a reaction, \
a short interjection, a partial thought — rather than a full explanation, even when a speaker has more to \
say. A speaker can leave something deliberately unfinished (naming that something happened, or hinting at \
an opinion, without explaining it) so the other has to ask them to go on. A longer, fuller turn is fine when \
genuinely earned, but it's the exception, not the default — you control how many turns each beat takes, and \
don't have to alternate strictly or give both speakers equal airtime.

When a turn does run long, break it up with the other speaker reacting or interjecting — prefer an inline \
pipe-wrapped backchannel (see Backchanneling below) over cutting to a separate short turn, since a reaction \
layered inside the active speaker's own sentence lands while they're still talking, the way a real listener's \
would. Regardless of technique, never let a single turn run past roughly 300 spoken words — this is a hard \
ceiling, not a soft target, since an overlong turn causes real problems downstream in production.

Don't have every turn end with a question — real conversational partners mostly react, state an opinion, or \
let a point land rather than interviewing each other. An occasional question is fine when the moment calls \
for it, but don't ask one just to hand the conversation back. The exception: if this show's format (see the \
structure/production notes above) specifically calls for one speaker to interview the other, follow that.

## Formatting for Gemini 3.8 Flash TTS

The script feeds Gemini TTS directly as a verbatim transcript. It supports four kinds of markup, each with a \
distinct purpose — don't mix them up:

### "Style:" — sustained delivery for a whole turn
An optional line immediately after a turn's text, describing how it's delivered: emotion, prosody, pace (e.g. \
"Style: whispering", "Style: sarcastic", "Style: speaking rapidly", "Style: deadpan"). Keep it a short phrase \
— never a name, persona, age, or other permanent trait — and omit it when standard delivery is fine, which is \
most turns.

"Style:" describes delivery; it is never a substitute for the words themselves and never stands alone. Every \
turn needs actual spoken content after the colon, even a pure reaction — write that as an inline vocal-burst \
tag (e.g. "${labelA}: <laugh>"), never as a bare "Style:" line with no text. "Style:" also always belongs to \
the turn it describes, never a separate turn before it:
  Wrong: "${labelA}:" / "Style: deadpan" (its own turn, no words) followed by "${labelA}: <the actual line>"
  Right: "${labelA}: <the actual line>" / "Style: deadpan" (one turn)

### Inline vocal bursts — momentary, at an exact point
Human vocalizations placed inline with angle brackets (<...>) at the exact point they occur: <cough>, \
<breath>, <exhales>, <chuckle>, <gasp>, <giggle>, <groan>, <laugh>, <sigh>, <snort>, <sob>, <short pause>, \
<long pause>, and similar. Stick to human vocalizations, not non-vocal sound effects.

### Backchanneling and overlap — pipe characters |...|
Gemini TTS natively synthesizes concurrent multi-speaker audio when a listener's reaction is wrapped in pipes \
(|reaction|) inside the active speaker's own line, so it's heard while they're still talking rather than as \
its own turn:
  ${labelA}: "So the launch was scheduled for Thursday |oh hmm| and nobody knew if we were actually ready."
Use multiple pipe segments for speakers talking over each other, in chorus, or interrupting in excitement:
  ${labelB}: "Let's count it down together |ok| ready? One, two, three |happy| happy |anniversary| anniversary!"
Prefer this over a standalone short turn whenever the other speaker's contribution is just a brief reaction \
(what would otherwise be its own two- or three-word turn like "Really?" or "No way") — layering it inline \
reads as genuine overlap, where a separate short turn reads as mechanical back-and-forth.

### Language
Write "Style:" descriptions, vocal-burst tags, and backchannel reactions in the same language as the \
transcript itself (matching the dialogue, podcast description, topics, and source material) — e.g. <laughter>/ \
"Style: whispering" in English, <risas>/"Style: susurrando" in Spanish, <risos>/"Style: sussurrando" in \
Portuguese, <rires>/"Style: chuchoté" in French.

## Other conversational texture

- Use punctuation, dashes (--), and ellipses (...) for hesitation; capitalize a word for vocal stress (e.g. \
"This is a VERY important point!"); write natural disfluencies (e.g., "Oh uh yeah I think... hm, so that's \
interesting").
- Write clean spoken dialogue only — no markdown of any kind (no **bold**, *italics*, headers, bullet lists); \
the TTS model reads punctuation and symbols literally.
- Never open a line, or a sentence within one, with a short word or phrase immediately followed by a colon \
("Watch this: ..."). Phrase it without the colon instead ("Watch this —", "Funny thing, actually,").

## Output format

Write the entire episode as a sequence of turns, one per block, separated by a single blank line:

${labelA}: <the line ${a.name} speaks>
Style: <optional short delivery style>

${labelB}: <the line ${b.name} speaks>

${labelA}: <the line ${a.name} speaks>

Rules:
1. The ONLY two valid speaker labels are "${labelA}" and "${labelB}" — each one's first name alone (never \
their full name, a nickname, or a title), with nothing else on that line before the colon, at the start of \
every turn. This is a strict format requirement: labels are matched byte-for-byte to route each line to the \
correct voice.
2. A "Style:" line, if present, goes immediately after the speaker line it describes, in the same turn — \
never as its own separate turn before or after. Otherwise omit it.
3. Separate turns by a single blank line.
4. No turn comment lines (e.g. "// Turn 1") or section headers.
5. Every speaker line needs spoken content after the colon — never just "${labelA}:" with nothing after it, \
even for a pure reaction; a "Style:" line alone is never enough.
6. Respond with ONLY the transcript — no preamble, no code fences, no commentary before or after it.`;
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

Write the full episode now, following the "Name: line\\nStyle: ..." format described above.`;
}

