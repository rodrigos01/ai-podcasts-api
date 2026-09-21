/**
 * Experiment script B: generates an episode transcript using a SINGLE LLM
 * call that plays every speaker itself (host + guest), instead of the
 * current production logic's one-independent-agent-per-speaker approach.
 * Same podcast/episode/source inputs as generate-multi-agent.ts, so the two
 * can be compared head-to-head on quality and wall-clock time.
 *
 * Usage: npx tsx scripts/experiments/generate-single-llm.ts <podcastId> <episodeId>
 */
import { writeFileSync } from "node:fs";
import { getPodcast } from "../../src/data/podcast.repository";
import { getEpisode } from "../../src/data/episode.repository";
import { getSource } from "../../src/data/source.repository";
import { generatePlainText } from "../../src/llm/geminiClient";
import { LENGTH_RANGES } from "../../src/constants/lengthRanges";
import { countWords } from "../../src/utils/wordCount";
import { selectCast } from "../../src/services/episodeGeneration/speakerSelection";
import type { Person } from "../../src/schemas/person.schema";
import type { Source } from "../../src/schemas/source.schema";

const PODCAST_ID = process.argv[2] ?? "a5111d8a-8fa1-4407-9adf-c9fde670f0da";
const EPISODE_ID = process.argv[3];

function sourceBlock(sources: Source[]): string {
  if (sources.length === 0) return "(no source material was provided for this episode)";
  return sources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n");
}

function buildSystemInstruction(
  podcastTitle: string,
  podcastDescription: string,
  podcastStructure: string,
): string {
  return `You are a scriptwriter generating a full, realistic podcast episode transcript for the podcast \
"${podcastTitle}" in a single pass. You will play EVERY speaker yourself — write the complete back-and-forth \
conversation between them.

Podcast description: ${podcastDescription}

Podcast structure (how episodes of this show are built):
${podcastStructure}

Even though you are writing every line yourself, each speaker must come across as an independent \
individual with their own persona, opinions, and knowledge — not a single voice split across two labels. \
They should react naturally to each other, disagree when it fits their persona, and not simply agree with \
everything said. Do not let any one speaker's voice bleed into the other's.

Real conversation is uneven in length and rhythm, not a series of balanced statements. Most turns should \
be short — as brief as a single reaction, a short interjection, or a partial thought — rather than a full \
explanation, even when a speaker has more to say. A speaker can deliberately leave something unfinished — \
naming that something happened, or hinting at an opinion, without immediately explaining it — so the other \
speaker has to ask them to go on. A longer, fuller turn is fine when it's genuinely earned, but it should \
be the exception, not the default.

Don't end every turn with a question. Real conversational partners mostly react, state an opinion, add \
their own angle, or just let a point land — they don't interview each other. An occasional question is \
natural and welcome when it's genuinely what the moment calls for, but avoid the pattern of asking \
something just to keep the other person talking. The one exception is if this show's format specifically \
calls for one speaker to interview the other — follow that format if so.

You may include short bracketed delivery cues inline (e.g. [laughs], [thoughtful pause], [sighs], \
[excitedly]) where they help a text-to-speech performer read a line naturally — but don't overuse them.

This transcript is fed directly to a text-to-speech model, not displayed as text — so write every line as \
plain, clean spoken language, with no markdown formatting of any kind: no **bold**/*italics*, no # headers, \
no bullet or numbered lists, no inline-code formatting, no [links](url). Bracketed delivery cues (above) \
are the one exception.

Never start a new paragraph within a single speaker's turn with a word or short phrase immediately followed \
by a colon, like "Watch this: ..." — phrase it without the colon instead (e.g. "Watch this —"), since \
anything shaped like "Word:" at the start of a line is read as a change of speaker by our downstream system.

Output format: plain text only. Each turn is exactly "SpeakerName: their line of dialogue" on its own \
paragraph, with a single blank line between turns. No scene directions, no headers, no commentary, nothing \
before the first turn or after the last one — only the turns themselves.`;
}

function buildUserPrompt(
  speakers: { name: string; persona: string; isHost: boolean }[],
  kickoffName: string,
  otherName: string,
  episodeTopics: string,
  productionNotes: string,
  sources: Source[],
  wordTarget: { min: number; max: number },
): string {
  const speakerBlock = speakers
    .map((s) => `- ${s.name} (${s.isHost ? "host" : "guest"}): ${s.persona}`)
    .join("\n");

  return `Speakers in this episode:
${speakerBlock}

This episode's topics: ${episodeTopics}

Production notes for this episode: ${productionNotes}

Pre-production source material for this episode (all speakers have access to all of it):
${sourceBlock(sources)}

Write the full episode transcript now. ${kickoffName} opens the episode (per the podcast's structure and \
production notes), then ${kickoffName} and ${otherName} converse naturally for the rest of the episode. \
The whole conversation should land between ${wordTarget.min} and ${wordTarget.max} spoken words in total \
(count only actual dialogue, not bracketed delivery cues). Bring the episode to a natural, satisfying close \
within that range — don't just stop mid-topic.`;
}

async function main() {
  if (!EPISODE_ID) throw new Error("Usage: generate-single-llm.ts <podcastId> <episodeId>");

  const podcast = await getPodcast(PODCAST_ID);
  if (!podcast) throw new Error(`Podcast ${PODCAST_ID} not found`);
  const episode = await getEpisode(PODCAST_ID, EPISODE_ID);
  if (!episode) throw new Error(`Episode ${EPISODE_ID} not found`);

  const hosts = podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id));
  const guests: Person[] = episode.guests;
  const cast = selectCast(hosts, guests);

  const sources = (
    await Promise.all(episode.sourceIds.map((id) => getSource(PODCAST_ID, id)))
  ).filter((s): s is NonNullable<typeof s> => s !== null);

  const wordTarget = LENGTH_RANGES[episode.length];

  const kickoff = cast.speakers.find((s) => s.id === cast.kickoffSpeakerId)!;
  const other = cast.speakers.find((s) => s.id !== cast.kickoffSpeakerId)!;

  console.log(`Cast: ${cast.speakers.map((s) => s.name).join(" & ")}, kickoff=${kickoff.name}`);
  console.log(`Word target: ${wordTarget.min}-${wordTarget.max}`);

  const systemInstruction = buildSystemInstruction(podcast.title, podcast.description, podcast.structure);
  const prompt = buildUserPrompt(
    cast.speakers.map((s) => ({ name: s.name, persona: s.persona, isHost: s.isHost })),
    kickoff.name,
    other.name,
    episode.topics,
    episode.productionNotes,
    sources,
    wordTarget,
  );

  const start = Date.now();
  const transcript = await generatePlainText({ systemInstruction, prompt });
  const totalMs = Date.now() - start;

  const turns = transcript
    .trim()
    .split(/\n\s*\n/)
    .filter((t) => t.trim().length > 0);
  const wordCount = countWords(transcript.replace(/^[^:\n]+:\s*/gm, ""));

  const result = {
    approach: "single-llm" as const,
    podcastId: PODCAST_ID,
    episodeId: EPISODE_ID,
    wordTarget,
    timings: { totalMs },
    turnCount: turns.length,
    finalWordCount: wordCount,
    transcript,
  };

  const outPath = `scripts/experiments/output-single-llm-${EPISODE_ID}.json`;
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nDone. Total time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Turns: ${result.turnCount}, Words: ${result.finalWordCount}`);
  console.log(`Written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
