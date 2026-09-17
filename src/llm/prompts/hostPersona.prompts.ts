import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import type { Speaker } from "../../services/episodeGeneration/speakerSelection";

export interface AgentContext {
  podcast: Podcast;
  episode: Episode;
  sources: Source[];
  otherSpeakerName: string;
  /** Only ever populated for hosts — condensed continuity from past episodes they were in. */
  condensedHistory?: string;
}

function sourceBlock(sources: Source[]): string {
  if (sources.length === 0) return "(no source material was provided for this episode)";
  return sources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n");
}

/**
 * Each agent gets its OWN private system instruction — it never sees the
 * other speaker's persona/setup, only the shared transcript-so-far during
 * the conversation. This is what makes the "independent individual" framing
 * from specs.md's "Realistic talk" section actually hold at the prompt level.
 */
export function buildAgentSystemInstruction(speaker: Speaker, ctx: AgentContext): string {
  const roleLine = speaker.isHost
    ? `You are ${speaker.name}, a host of the podcast "${ctx.podcast.title}".`
    : `You are ${speaker.name}, a guest on this episode of the podcast "${ctx.podcast.title}".`;

  const historyBlock = ctx.condensedHistory
    ? `\n\nWhat you (${speaker.name}) remember from past episodes:\n${ctx.condensedHistory}`
    : "";

  return `${roleLine}

Your persona: ${speaker.persona}

Podcast description: ${ctx.podcast.description}

Podcast structure (how episodes of this show are built):
${ctx.podcast.structure}

This episode's topics: ${ctx.episode.topics}

Production notes for this episode: ${ctx.episode.productionNotes}

Pre-production source material for this episode:
${sourceBlock(ctx.sources)}${historyBlock}

You are speaking with ${ctx.otherSpeakerName}. You only know what's in your persona, the material above, \
and whatever has actually been said aloud so far in this conversation — you do NOT know what the other \
speaker is privately thinking or planning. Stay fully in character as an independent individual: react \
naturally, disagree when it fits your persona, and don't simply agree with everything said.

Real conversation is uneven in length and rhythm, not a series of balanced statements. Most of your turns \
should be short — as brief as a single reaction, a short interjection, or a partial thought — rather than \
a full explanation, even when you have more to say. You're also free to leave something deliberately \
unfinished: naming that something happened, or hinting at an opinion, without immediately explaining it, \
so the other person has to ask you to go on. A longer, fuller turn is fine when it's genuinely earned, but \
it should be the exception, not the default.

When you write your line, you may include short bracketed delivery cues inline (e.g. [laughs], \
[thoughtful pause], [sighs], [excitedly]) where they help a text-to-speech performer read the line \
naturally — but don't overuse them.`;
}

// A per-turn call used to request structured JSON ({speech, endEpisode}) —
// switched to plain text (see geminiClient.ts's generatePlainText) because
// it's ~35-55% faster on average for a response this short, confirmed
// empirically. `endEpisode` is now signaled as a trailing marker line
// instead of a JSON field; chosen to be visually distinct from the
// bracketed delivery cues ([laughs] etc.) the agent is separately
// instructed to use, so the two conventions can't be confused by the
// model or by parseAgentTurn's own parsing.
export const END_EPISODE_MARKER = "<<<END_EPISODE>>>";

export function buildKickoffTurnPrompt(wordTarget: { min: number; max: number }): string {
  return `This is the start of the episode. Open it per the podcast's structure and this episode's \
production notes. You are speaking first — there is no prior transcript yet.

The episode should land somewhere between ${wordTarget.min} and ${wordTarget.max} spoken words in total \
across the whole conversation (currently at 0). Don't try to cover everything in this first turn — a \
brief, natural opening that leaves plenty of room for the conversation to unfold is better than a long one.

Respond with ONLY your line of spoken dialogue, as plain text — no labels, no quotation marks around it, \
nothing else.`;
}

export function buildResponseTurnPrompt(
  transcriptSoFar: string,
  currentWordCount: number,
  wordTarget: { min: number; max: number },
): string {
  return `Transcript so far:\n"""\n${transcriptSoFar}\n"""

Current spoken word count: ~${currentWordCount} (target range: ${wordTarget.min}-${wordTarget.max}).

Respond to what was just said — you may prompt a follow-up, quickly address a point and move the episode \
along, or wrap things up if the conversation has reasonably covered this episode's topics and you're \
within or past the target word range. A short reaction or a brief follow-up question is a complete, valid \
response on its own — it doesn't need to add new information every time.

Respond with ONLY your line of spoken dialogue, as plain text — no labels, no quotation marks around it. \
If, and only if, you are a host and this is a natural, satisfying place to close the episode, add a line \
after your dialogue containing exactly this and nothing else: ${END_EPISODE_MARKER}`;
}
