/**
 * Runs just the episode wizard's draft call for episode N of a podcast whose
 * earlier episodes already have transcripts, as a fast check of what the draft
 * (and its continuity notes) look like. Nothing is written to Firestore: the
 * result is printed and saved to a file. The history is the first N-1 episodes
 * of <historyPodcastId> (their stored transcripts), the sources, length and
 * podcast definition are the history podcast's, and the user prompt is the same
 * numbered episode's production notes in <notesPodcastId> (as --redraft does).
 * The draft is made as a podcast on continuity notes (transcripts go in the
 * wizard's system instruction, no chain), whatever the podcast's own flags.
 *
 *   npx tsx .claude/skills/prompt-ab-test/scripts/draft-only.ts <historyPodcastId> <notesPodcastId> <episodeNumber> <outFile>
 */
import { writeFileSync } from "node:fs";
import { generateSuggestions } from "../../../../src/services/episodeWizard.service";
import { inSeriesOrder } from "./lib";
import { firestore } from "../../../../src/config/firebase";
import { getSource } from "../../../../src/data/source.repository";
import type { Podcast } from "../../../../src/schemas/podcast.schema";
import type { PriorEpisode } from "../../../../src/utils/episodeHistory";

async function main() {
  const [historyId, notesId, numberArg, outFile] = process.argv.slice(2);
  if (!historyId || !notesId || !numberArg || !outFile) throw new Error("usage: draft-only.ts <historyPodcastId> <notesPodcastId> <episodeNumber> <outFile>");
  const n = Number(numberArg);
  const stored = (await firestore.collection("podcasts").doc(historyId).get()).data() as Podcast;
  const podcast: Podcast = { ...stored, title: stored.title.replace(/\s*\(Test [^)]*\)\s*$/, ""), continuityNotes: true };
  const episodes = await inSeriesOrder(historyId);
  const target = episodes[n - 1]!;
  const previous: PriorEpisode[] = episodes
    .slice(0, n - 1)
    .map((episode, i) => ({ number: i + 1, episode }))
    .filter((p) => p.episode.transcript);
  const sources = (await Promise.all(target.sourceIds.map((id) => getSource(historyId, id)))).filter((s) => s !== null);
  const prompt = (await inSeriesOrder(notesId))[n - 1]?.productionNotes;
  const result = await generateSuggestions(podcast, sources, target.length, previous, prompt);
  const draft = result.suggestions[0]!.episodes[0]!;
  const text = `# Draft for episode ${n} (history: episodes 1-${n - 1} of ${historyId}; wizard returned ${result.suggestions.map((s) => `${s.episodes.length} ep`).join(" + ")})

## Title
${draft.title}

## Topics
${draft.topics}

## Guest
${draft.guests[0] ? `${draft.guests[0].name}: ${draft.guests[0].persona}` : "(none)"}

## Production notes
${draft.productionNotes ?? "(none)"}

## Continuity notes
${draft.continuityNotes ?? "(none)"}
`;
  writeFileSync(outFile, text);
  console.log(`episode ${n}: ${draft.continuityNotes?.length ?? 0} chars of notes -> ${outFile}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
