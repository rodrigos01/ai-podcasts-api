/**
 * Throws away an arm's generated episodes from `fromEpisode` on (default 2),
 * back to the unscripted state setup-arm.ts leaves them in, so generate-arms.ts
 * regenerates them. Use it after fixing a bug in the code under test.
 *
 *   npx tsx .claude/skills/prompt-ab-test/scripts/reset-arm.ts <armPodcastId> [fromEpisode=2]
 */
import { patchEpisodeState } from "../../../../src/data/episode.repository";
import { inSeriesOrder, log } from "./lib";

async function main() {
  const [podcastId, fromArg] = process.argv.slice(2);
  if (!podcastId) throw new Error("usage: reset-arm.ts <armPodcastId> [fromEpisode]");
  const from = Number(fromArg ?? 2);
  const episodes = await inSeriesOrder(podcastId);
  for (const [i, e] of episodes.entries()) {
    if (i + 1 < from) continue;
    await patchEpisodeState(podcastId, e.id, {
      status: "generating",
      transcript: null,
      ttsChunks: null,
      interactionId: null,
      progress: null,
      error: null,
      generationLease: null,
    });
  }
  log("reset", `episodes ${from}..${episodes.length} of ${podcastId}`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
