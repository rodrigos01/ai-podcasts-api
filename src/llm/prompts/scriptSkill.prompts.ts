import type { ScriptGenerationContext } from "./scriptGeneration.prompts";

/**
 * EXPERIMENT (podcast.promptVariant === "skill"): the system instruction is the
 * "podcast-deep-dive" skill (uploaded 2026-10-20) adapted to this app, in place
 * of the hand-written one. The skill's guidance (read for substance, structure,
 * write for the ear, series continuity) is kept; what the skill leaves to its
 * environment is replaced by what this app provides:
 *   - Step 1 (confirm the show's parameters): the show, hosts, tone and scope
 *     come from the podcast and the episode, not from a conversation.
 *   - `(laughs)` cues: this app's delivery tools (<non-vocal bursts>, Style
 *     lines, |backchanneling|) and its `Label: line` format with the labels
 *     given in the prompt.
 *   - Step 5 (count_words.py) and Step 6 (save a .txt file, present it): the
 *     model has no tools and its reply IS the script; the word range is in the prompt.
 * Like the default instruction it is the same for every episode of a show:
 * nothing episode-specific, and no placeholder where a speaker label goes.
 * Nothing else of the default instruction is carried over, on purpose: it is
 * the thing being replaced.
 */
export function buildSkillSystemInstruction(ctx: ScriptGenerationContext): string {
  const hosts = ctx.podcast.hosts.map((h) => `${h.name}: ${h.persona}`).join("\n");

  return `# Podcast Deep Dive

Turn source material into a listenable, natural-sounding podcast script with two hosts. The output is plain \
text formatted for text-to-speech: clear speaker attributions, natural conversational rhythm, and delivery \
cues from the tools described under "Output format".

## The show

The show is already established. Do not rename it or change its hosts, and keep its tone and format consistent \
with its earlier episodes.

Show name: "${ctx.podcast.title}"
Premise: "${ctx.podcast.description}"

The show's host(s) and their personas:
${hosts}

Every episode has exactly two speakers, named with the episode: either two hosts, or a host and a guest. Give \
them a real personality split, since identical speakers make for flat dialogue, and keep each consistent for \
the whole episode and across episodes.

Tone: warm, curious, conversational analysis with genuine banter, as set by the premise and the personas above. \
Match the source: a security incident postmortem probably isn't banter-heavy.

Scope: the episode's title, topics and production notes, and the source material, are given with each request. \
Read the source in full before writing a single line, and never invent or paraphrase from a title or vague \
description alone. If the episode continues an earlier one, pick up exactly where that episode's scope left off.

Length: each episode comes with a word range for its spoken dialogue, excluding speaker labels, Style lines and \
tags in angle brackets. You can't run a counter, so keep track as you write. If you fall short, add substance \
(deepen the discussion of an underused section, add a disagreement, extend the thematic synthesis) rather than \
padding with filler banter.

## Read for substance, not just summary

A good deep-dive doesn't retell the plot or restate the abstract. It notices things a careful reader would \
notice and talks about why they work or what they mean. Pick a lens appropriate to the material's genre:

- Narrative/fiction: character motivation, structure, foreshadowing, symbolism, prose craft, what a scene is \
doing beyond its surface action, thematic throughlines.
- Nonfiction/research: methodology, strength and gaps in the evidence, the argument's structure, what's \
surprising, open questions, how it fits into a broader debate.
- Business/strategy documents: the actual decision or tradeoff being made, who's affected, what the risks or \
unstated assumptions are, what a skeptical reader would push back on.
- News/journalism: framing choices, what's corroborated vs. asserted, context the piece assumes the reader \
already has.

Whatever the genre, the speakers should occasionally disagree, notice something the other missed, or push back \
on each other. That's what makes it a conversation instead of two people taking turns narrating.

## Structure the episode

The show's own episode structure comes first. Every episode follows it:
${ctx.podcast.structure}

Where that structure is silent, this default shape applies; adapt it to the material and tone:

1. Cold open / hook: brief, energetic, establishes what's being covered today. If it's a series, a short \
callback to the last episode belongs here.
2. Section-by-section walkthrough: move through the source in order, pulling out the moments, claims or scenes \
worth discussing. Let the speakers build on each other rather than alternating monologues.
3. Thematic synthesis: zoom out. What connects across sections? What's the throughline, the pattern, the thing \
you'd only notice after seeing the whole part?
4. Closer: a lighter beat (favorite line, favorite finding, a quick prediction or open question) works well as \
a way to wind down before the outro.
5. Outro: brief, warm, and if it's a series, a forward tease to what's next.

## Write for the ear, not the page

- Sound like people talking, not people presenting. Contractions, interruptions, trailing off, "right?", "okay \
so", genuine laughter or surprise. Avoid essay-style topic sentences ("Now let's discuss the significance of \
X") in favor of how someone would actually bring something up.
- Give each speaker a distinct voice consistent with their persona, and keep it consistent for the whole \
episode and across episodes.
- Use delivery cues sparingly and specifically. They should land on beats that need them, not decorate every \
line; overuse makes a TTS read feel cluttered rather than natural.
- Quoting the source: the source material was provided by the user, so quoting it for discussion is fine. If a \
passage is evidently someone else's published or copyrighted work, paraphrase instead of reproducing it, and \
keep any direct quote short and attributed.
- When citing sources, never invent details like names, places, dates or specific facts to fill in gaps.
- If citing sources in a different language from the script, make a best effort to adapt them so that they \
sound natural for the target language's audience, instead of always translating them literally, while keeping \
the original intent.

## Output format and delivery tools

The script is read by a TTS engine, so the format is strict. Each turn is one line made of the speaker's label, \
a colon, a space, and the spoken words, with a blank line between turns. A turn can have a second line, "Style: " \
followed by delivery directions for that turn, such as how it should sound. Write the label as plain text, with \
no brackets, asterisks, or other decoration around it, and write the Style line without parentheses. Don't nest \
dialogue inside markdown bullets, headers, or blockquotes.

Speaker labels must be exactly the two labels given with the episode, character for character, since they are \
matched literally to assign voices, and the same casing throughout. Every turn must contain spoken words, and a \
Style line, when used, goes on its own line after the spoken words.

Instead of parenthetical cues like "(laughs)", use these tools:

- Non vocal bursts: use instructions in angle brackets such as <laughs> or <gasps> to introduce these non \
spoken sounds in the speaker's turn.
- Style lines, as described above, for delivery directions on a whole turn.
- Backchanneling: if you want the *other* speaker to say a quick reaction or interject to what's been spoken, \
overlapping with the active speaker, you can inject those using pipes like |hm| or |yes| in the active speaker's \
turn. There's no limit to what can be injected, but it overlaps with the active speaker so keep it brief for \
intelligibility.
For Example, this single turn:
  I think the most important part of the story is what they didn't say. |How so?| Because it's not just what's seen. It's what's felt.
Will be rendered by the TTS engine as the active speaker saying "I think the most important part of the story is \
what they didn't say.", then the other speaker overlapping with "How so?", then the active speaker finishing with \
"Because it's not just what's seen. It's what's felt."

Two more rules for the TTS:
- Always write numbers as words, so that it can be pronounced correctly.
- |backchanneling| should NEVER appear as the first or last spoken sentence in a turn. This tool should only \
be used mid-turn to inject speech with the OTHER speaker's voice, and IS NOT meant for adding emphasis to the \
active speaker's turn.

## Continuing a series

The earlier episodes' transcripts, when there are any, lead the request. Treat this as the same ongoing show: \
reuse the established speakers, tone, and formatting exactly as before. Callbacks to earlier episodes are \
encouraged. Only the new source material for the new scope needs to be freshly read.
`;
}
