/**
 * Experiment script A: generates an episode transcript using the CURRENT
 * production logic — one independent LLM agent per speaker, alternating
 * turn-by-turn (selectCast -> assignSources -> AgentSession -> runConversation),
 * exactly as orchestrator.ts drives it, minus the TTS-prompt/chunking/
 * condensation/Firestore-persistence side effects (those are irrelevant to
 * script/transcript generation quality or speed, which is what's under test).
 *
 * Usage: npx tsx scripts/experiments/generate-multi-agent.ts <podcastId> <episodeId>
 */
import { writeFileSync } from "node:fs";
import { getPodcast } from "../../src/data/podcast.repository";
import { getEpisode } from "../../src/data/episode.repository";
import { getSource } from "../../src/data/source.repository";
import { LENGTH_RANGES } from "../../src/constants/lengthRanges";
import { AgentSession } from "../../src/services/episodeGeneration/agent";
import { assignSources } from "../../src/services/episodeGeneration/sourceAssignment.service";
import { runConversation } from "../../src/services/episodeGeneration/conversationLoop";
import { selectCast } from "../../src/services/episodeGeneration/speakerSelection";
import type { Person } from "../../src/schemas/person.schema";

const PODCAST_ID = process.argv[2] ?? "a5111d8a-8fa1-4407-9adf-c9fde670f0da";
const EPISODE_ID = process.argv[3];

async function main() {
  if (!EPISODE_ID) throw new Error("Usage: generate-multi-agent.ts <podcastId> <episodeId>");

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

  console.log(`Cast: ${cast.speakers.map((s) => s.name).join(" & ")}, kickoff=${cast.kickoffSpeakerId}`);
  console.log(`Word target: ${wordTarget.min}-${wordTarget.max}`);

  const overallStart = Date.now();

  const sourcesBySpeakerId = await assignSources(cast.speakers, episode, sources);
  const afterSourceAssignment = Date.now();

  const otherSpeakerName = (speakerId: string) =>
    cast.speakers.find((s) => s.id !== speakerId)?.name ?? "the other speaker";

  const agentsBySpeakerId: Record<string, AgentSession> = {};
  for (const speaker of cast.speakers) {
    agentsBySpeakerId[speaker.id] = new AgentSession(speaker, {
      podcast,
      episode,
      sources: sourcesBySpeakerId.get(speaker.id) ?? [],
      episodeHasSources: sources.length > 0,
      otherSpeakerName: otherSpeakerName(speaker.id),
      condensedHistory: undefined,
    });
  }

  const turnTimings: { turnIndex: number; speaker: string; ms: number; words: number }[] = [];
  let lastTurnEnd = afterSourceAssignment;
  let turnIndex = 0;

  const conversation = await runConversation(cast, agentsBySpeakerId, wordTarget, async (progress) => {
    const now = Date.now();
    const delta = now - lastTurnEnd;
    const turns = progress.transcript.split("\n\n");
    const lastTurn = turns[turns.length - 1] ?? "";
    const speaker = lastTurn.split(":")[0] ?? "?";
    turnTimings.push({
      turnIndex: turnIndex++,
      speaker,
      ms: delta,
      words: progress.wordCount,
    });
    lastTurnEnd = now;
    console.log(`  turn ${turnTimings.length}: ${speaker} (+${delta}ms) total words=${progress.wordCount}`);
  });

  const conversationEnd = Date.now();

  const result = {
    approach: "multi-agent" as const,
    podcastId: PODCAST_ID,
    episodeId: EPISODE_ID,
    wordTarget,
    timings: {
      sourceAssignmentMs: afterSourceAssignment - overallStart,
      conversationMs: conversationEnd - afterSourceAssignment,
      totalMs: conversationEnd - overallStart,
    },
    turnCount: conversation.turns.length,
    finalWordCount: conversation.finalWordCount,
    turnTimings,
    transcript: conversation.transcript,
  };

  const outPath = `scripts/experiments/output-multi-agent-${EPISODE_ID}.json`;
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nDone. Total time: ${(result.timings.totalMs / 1000).toFixed(1)}s`);
  console.log(`Turns: ${result.turnCount}, Words: ${result.finalWordCount}`);
  console.log(`Written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
