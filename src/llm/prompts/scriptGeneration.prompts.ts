import type { PriorEpisode } from "../../utils/episodeHistory";
import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import { buildChainedHistoryNote, buildEpisodeHistoryBlock } from "./episodeHistory.prompts";
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

export function sourceBlock(sources: Source[]): string {
  if (sources.length === 0) return "(no source material was provided for this episode)";
  return sources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n");
}

// Rough conversational speech rate, used only to tell the writer what episode
// duration its word target corresponds to.
const WORDS_PER_MINUTE = 155;

/**
 * Earlier episodes are shared history, not a template for new ones — the
 * model tends to rebuild an episode around the shape of the ones it is shown.
 * The one thing worth carrying over verbatim is the show's catchphrases.
 */
const HISTORY_IS_NOT_A_TEMPLATE_RULE = `- Earlier episodes of this show are shared history, not a template for new ones. Do not reuse an earlier \
episode's structure, beats, pacing, jokes, or phrasing to build this episode. The one exception is the show's \
catchphrases (its recurring signature phrases, such as greetings, sign-offs, and segment names), which can be \
reused as they were.`;

/**
 * Mandatory spoken-register rules, for podcasts with `naturalSpeech: true`
 * (an A/B arm; absent renders the system instruction exactly as before).
 * Fillers are plain spoken words, not angle-bracket tags, so the TTS says them.
 */
export function usesNaturalSpeech(podcast: Pick<Podcast, "naturalSpeech">): boolean {
  return podcast.naturalSpeech === true;
}

const NATURAL_SPEECH_SECTION = `
Natural speech (mandatory): this is a script for two people talking, not for someone reading a text aloud. \
Every line must sound like it was said spontaneously, in each speaker's own voice, as their persona would really \
talk. This is required in every turn, not an occasional flourish:
- Write for the ear, not the page. Use contractions, sentence fragments, run-ons and everyday words. Avoid \
polished, essay-like, balanced or tidily structured sentences, and avoid formal or "written" vocabulary a real \
person wouldn't use out loud.
- Speakers think while they talk. Include natural disfluencies and filler, written as plain spoken words so the \
TTS voices them: interjections and hesitation sounds such as hm, ah, oh, uh, um, mm, well, so, I mean, you know, \
and also false starts, self-corrections, trailing off, restarting a thought, searching for a word, and \
repeating a word while thinking. Place them where a real person would, such as before an answer they have to \
think about, while recalling a detail, or when changing their mind. Most turns of more than a sentence or two \
should have at least one, and they should not be spread evenly or follow a pattern.
- Let each persona decide how they sound. Their background, age, temperament, humor, vocabulary and regional \
or professional speech habits shape how formal they are, how much they hedge, how fast they ramble, and which \
fillers and expressions they favor. Two speakers must never share the same speech patterns, and neither should \
sound like a neutral assistant.
- Reactions are spoken, not described. Surprise, doubt, amusement and agreement come out as sounds and half \
sentences ("oh", "wait, really?", "hm, right") rather than as complete, articulate statements about the feeling.
- Don't open turns with a neat acknowledgement of what the other person said and then a prepared answer. People \
jump in, answer sideways, or answer a different part of the question.
- Don't make information sound organized in advance: no lists of "first, second, third", no mini-lectures with \
a thesis and a conclusion, no summarizing sentence closing each turn.
- Keep filler believable and readable: never so dense that the content is lost, and never inside the angle-bracket \
tags, which stay limited to the mouth sounds listed below.
`;

/**
 * A single system instruction that writes BOTH speakers' lines itself —
 * see AGENTS.md's migration note: a single writer can't structurally keep
 * each speaker's knowledge separate; the prompt only asks for it.
 *
 * It is the same for every episode of a show, so nothing episode-specific may
 * go in it: not the history (that leads the prompt, see
 * `buildScriptGenerationPrompt`), and not the speakers' labels, which depend
 * on who the guest is. It must not show a placeholder where a label would
 * go either: the model copies one literally (e.g. "[Penny]: ..." from
 * "[first label]: ..."), which the script parser doesn't recognise.
 */
export function buildScriptSystemInstruction(ctx: ScriptGenerationContext): string {
  const hosts = ctx.podcast.hosts.map((h) => `${h.name}: ${h.persona}`).join("\n");
  const naturalSpeech = usesNaturalSpeech(ctx.podcast);

  return `You are a script writer for a podcast called "${ctx.podcast.title}". The podcast premise is as follows:
"${ctx.podcast.description}"
And episodes follow this structure:
${ctx.podcast.structure}

The show host(s) are:
${hosts}

Unless the podcast description or structure above says otherwise, the tone is light and conversational, with \
banter and chemistry between the speakers. Don't turn an episode into a lecture: educational exposition belongs \
only in shows that explicitly ask for it.

The scripts will be used with a TTS engine. Each turn is one line made of the speaker's label, a colon, a space, \
and the spoken words, with a blank line between turns. A turn can have a second line, "Style: " followed by \
delivery directions for that turn. Write the label as plain text, with no brackets, asterisks, or other \
decoration around it, and write the Style line without parentheses and without a speaker label of its own.

Speaker labels must be exactly the two labels given with the episode, character for character — they are matched \
literally to assign voices. Every turn must contain spoken words, and a Style line, when used, goes on its \
own line after the spoken words.

Each turn is one speaker's label and line. Keep the conversation natural and dynamic, the way real people \
talk. There is no set length for a turn: quick reactions, interjections and one-line replies mix with longer \
stretches when someone is telling a story or making a point, and the other speaker reacts, interrupts or adds \
their own take along the way instead of waiting politely for their turn. Don't pad a turn to make it longer, and \
don't split one speaker's continuous stretch into several turns in a row or have the other speaker finish \
their sentences. Very short reactions work best as backchanneling (see below).
${naturalSpeech ? NATURAL_SPEECH_SECTION : ""}
Keep the different speakers as their own individuals, avoiding them sounding like a single entity speaking in \
turn or completing each other's sentences. If it makes sense for the speakers personas to disagree, they should. \
If the speakers have explicitly different roles, such as host and guest, make sure they stick to their roles, unless \
breaking character is a key part of the conversation.

Make each speaker believable. Give them texture: the habits, opinions, ways of talking and small personal \
details their persona or bio suggests, showing up naturally in how they react and what they bring up, never \
announced as a list, and consistent for the whole episode. Keep what they know aligned with who they are: a \
speaker only explains what their persona, bio and experience would plausibly give them, such as their own craft, \
their home ground and what they have lived through. When the material calls for expertise neither speaker would \
plausibly have, don't have anyone explain it. They can relay what the source says as the source's account, say \
they don't know, wonder about it, or move on. If neither speaker would plausibly say it, it shouldn't be said.

The show is an ongoing series, and when you are given earlier episodes they are its shared history. Callbacks \
to them are welcome where they come up naturally, such as a brief nod to the last episode in the opening, a \
running joke, or a follow-up on something left open, and the speakers, tone and format should stay as \
established. A callback is a deliberate reference, not a reuse of an earlier episode's structure or phrasing \
(see the rules below). Write the new episode from its own sources: only the new material needs fresh reading.

You can use the following tags to make the conversation more realistic:

- Non vocal bursts: angle brackets are only for simple non verbal sounds a speaker can make with their mouth, \
written as one or two words, such as <laughs>, <gasps> or <sighs>. The only other tag that works is <claps>. \
Anything else is not valid: no stage directions, actions, gestures or descriptions of how something is said, and \
never spoken words inside the brackets. How a whole turn should sound goes in its Style line.
- Backchanneling: if you want the *other* speaker to say a quick reaction or interject to what's been spoken, \
overlapping with the active speaker, you can inject those using pipes like |hm| or |yes| in the active speaker's \
turn. There's no limit to what can be injected, but it overlaps with the active speaker so keep it brief for \
intelligibility.
For Example, this single turn:
  I think the most important part of the story is what they didn't say. |How so?| Because it's not just what's seen. It's what's felt.
Will be rendered by the TTS engine as the active speaker saying "I think the most important part of the story is \
what they didn't say.", then the other speaker overlapping with "How so?", then the active speaker finishing with \
"Because it's not just what's seen. It's what's felt."

The following rules must be followed:
- When citing sources, never invent details like names, places, dates or specific facts to fill in gaps. Translations can be adapted (see below).
- Always write numbers as words, so that it can be pronounced correctly.
- If citing sources in a different language from the script, make a best effort to adapt them so that they \
sound natural for the target language's audience, instead of always translating them literally, while keeping the original intent.
- Avoid recaps: don't summarize the episode so far, the segment that just ended, or past episodes, unless the \
podcast structure asks for one.
- |backchanneling| should NEVER appear as the first or last spoken sentence in a turn. This tool should only \
be used mid-turn to inject speech with the OTHER speaker's voice, and IS NOT meant for adding emphasis to the \
active speaker's turn.
${HISTORY_IS_NOT_A_TEMPLATE_RULE}${naturalSpeech ? "\n- Follow the natural speech requirements above in every turn: no turn may read like written text spoken aloud." : ""}
`;
}

/**
 * `chained`: the call continues the series' stored interaction, so the earlier
 * episodes are already in the conversation and `ctx.previousEpisodes` is empty;
 * a note says so instead of the transcripts being pasted in.
 */
export function buildScriptGenerationPrompt(
  cast: Cast,
  ctx: ScriptGenerationContext,
  wordTarget: WordTarget,
  chained = false,
): string {
  const minutes = Math.round((wordTarget.min + wordTarget.max) / 2 / WORDS_PER_MINUTE);
  const guest = cast.speakers.find((s) => !s.isHost);
  const guestBlock = guest
    ? `\n\nThe guest for this episode is ${guest.name} and here's their bio: ${guest.persona}`
    : "";
  const draft = `Title: ${ctx.episode.title}\nTopics: ${ctx.episode.topics}${ctx.episode.productionNotes ? `\nProduction notes: ${ctx.episode.productionNotes}` : ""
    }`;

  const [a, b] = cast.speakers;
  const history = chained ? buildChainedHistoryNote() : buildEpisodeHistoryBlock(ctx.previousEpisodes, ctx.podcast);
  const historySection = history
    ? `${history}

The history might have been generated with an earlier version of the show's title, premise, structure or \
host personas, so prioritize the details in the system instructions above past episode's formulas.

`
    : "";

  return `${historySection}Write the script for an episode based on the sources below, following this draft:
${draft}${guestBlock}

The speaker labels for this episode are exactly "${speakerLabel(a.name, b.name)}" and "${speakerLabel(b.name, a.name)}".

The script *must* have between ${wordTarget.min}-${wordTarget.max} words (for a ~${minutes}m episode).

Sources:
${sourceBlock(ctx.sources)}`;
}
