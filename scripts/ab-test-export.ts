/**
 * One-off: writes an A/B-test arm's transcripts (and the notes each was given,
 * when it has any) to `<outDir>/<label><n>.md` / `<label><n>-notes.md`.
 *
 *   npx tsx scripts/ab-test-export.ts <podcastId> <label> <outDir> [lastEpisode=5]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { listEpisodes } from "../src/data/episode.repository";

async function main() {
  const [podcastId, label, outDir, lastArg] = process.argv.slice(2);
  if (!podcastId || !label || !outDir) throw new Error("usage: ab-test-export.ts <podcastId> <label> <outDir> [lastEpisode]");
  mkdirSync(outDir, { recursive: true });
  const episodes = (await listEpisodes(podcastId)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  episodes.slice(0, Number(lastArg ?? 5)).forEach((e, i) => {
    if (!e.transcript) return;
    writeFileSync(`${outDir}/${label}${i + 1}.md`, `# ${label}${i + 1}: ${e.title}\n\n${e.transcript}\n`);
    if (e.pastNotes) writeFileSync(`${outDir}/${label}${i + 1}-notes.md`, `# Notes given to ${label}${i + 1}\n\n${e.pastNotes}\n`);
    console.log(`${label}${i + 1}`, e.transcript.split(/\s+/).length, "words", e.pastNotes ? `${e.pastNotes.length} chars of notes` : "");
  });
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
