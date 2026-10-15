/**
 * One-off: throws away an A/B-test arm's generated episodes from `fromEpisode`
 * on (default 2), back to the unscripted state setup left them in, so
 * ab-test-generate-arm.ts regenerates them.
 *
 *   npx tsx scripts/ab-test-reset-arm.ts <podcastId> [fromEpisode=2]
 */
import { patchEpisodeState } from "../src/data/episode.repository";
import { inSeriesOrder, log } from "./lib/abTest";

async function main() {
  const [podcastId, fromArg] = process.argv.slice(2);
  if (!podcastId) throw new Error("usage: ab-test-reset-arm.ts <podcastId> [fromEpisode]");
  const from = Number(fromArg ?? 2);
  const episodes = await inSeriesOrder(podcastId);
  for (const [i, e] of episodes.entries()) {
    if (i + 1 < from) continue;
    await patchEpisodeState(podcastId, e.id, {
      status: "generating",
      transcript: null,
      ttsChunks: null,
      interactionId: null,
      pastNotes: null,
      progress: null,
      error: null,
      generationLease: null,
    });
  }
  log("reset", `episodes ${from}..${episodes.length} of ${podcastId}`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
