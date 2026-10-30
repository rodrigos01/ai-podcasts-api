/**
 * Runs just the notes-only call (what the orchestrator does for an episode with
 * no continuity notes, or a later part of a split) for episode N of a podcast
 * whose earlier episodes have transcripts, and prints the notes next to the
 * ones stored on the episode. Nothing is written.
 *
 *   npx tsx .claude/skills/prompt-ab-test/scripts/notes-only.ts <podcastId> <episodeNumber> <outFile>
 */
import { writeFileSync } from "node:fs";
import { firestore } from "../../../../src/config/firebase";
import { getSource } from "../../../../src/data/source.repository";
import { writeContinuityNotes } from "../../../../src/services/episodeGeneration/continuityNotes.service";
import type { Podcast } from "../../../../src/schemas/podcast.schema";
import type { PriorEpisode } from "../../../../src/utils/episodeHistory";
import { baseTitle, inSeriesOrder } from "./lib";

async function main() {
  const [podcastId, numberArg, outFile] = process.argv.slice(2);
  if (!podcastId || !numberArg || !outFile) throw new Error("usage: notes-only.ts <podcastId> <episodeNumber> <outFile>");
  const n = Number(numberArg);
  const stored = (await firestore.collection("podcasts").doc(podcastId).get()).data() as Podcast;
  const podcast = { ...stored, title: baseTitle(stored.title) };
  const episodes = await inSeriesOrder(podcastId);
  const episode = episodes[n - 1]!;
  const previous: PriorEpisode[] = episodes.slice(0, n - 1).map((e, i) => ({ number: i + 1, episode: e })).filter((p) => p.episode.transcript);
  const sources = (await Promise.all(episode.sourceIds.map((id) => getSource(podcastId, id)))).filter((s) => s !== null);
  const notes = await writeContinuityNotes(podcast, episode, sources, previous);
  writeFileSync(outFile, `# Notes-only call for episode ${n}: ${episode.title}\n\n## Written by the notes-only call (history: episodes 1-${n - 1})\n${notes ?? "(none)"}\n\n## Stored on the episode (written by the draft call)\n${episode.continuityNotes ?? "(none)"}\n`);
  console.log(`episode ${n}: ${notes?.length ?? 0} chars -> ${outFile}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
