/**
 * Writes an arm's transcripts to `<outDir>/<label><n>.md` (one file per
 * episode, plain "Name: line" turns under a title), and prints word counts.
 *
 *   npx tsx .claude/skills/prompt-ab-test/scripts/export.ts <podcastId> <label> <outDir> [lastEpisode=5]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { inSeriesOrder } from "./lib";

async function main() {
  const [podcastId, label, outDir, lastArg] = process.argv.slice(2);
  if (!podcastId || !label || !outDir) throw new Error("usage: export.ts <podcastId> <label> <outDir> [lastEpisode]");
  mkdirSync(outDir, { recursive: true });
  const episodes = await inSeriesOrder(podcastId);
  episodes.slice(0, Number(lastArg ?? 5)).forEach((e, i) => {
    if (!e.transcript) return;
    writeFileSync(`${outDir}/${label}${i + 1}.md`, `# ${label}${i + 1}: ${e.title}\n\n${e.transcript}\n`);
    console.log(`${label}${i + 1}`, e.transcript.split(/\s+/).length, "words");
  });
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
