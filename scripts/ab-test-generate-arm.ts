/**
 * One-off: generates one arm of the history-method A/B test on its own, on top
 * of the shared baseline — episode 1's transcript is copied from `seedPodcast`
 * (the same text A and B have), then episodes 2..N are generated one after the
 * other with the arm's own historyMethod. Resumable. See ab-test-generate.ts.
 *
 *   npx tsx scripts/ab-test-generate-arm.ts <armPodcastId> <seedPodcastId> [lastEpisode=5]
 */
import { inSeriesOrder, generate, log, ready, writeEpisode } from "./lib/abTest";

async function main() {
  const [armId, seedId, lastArg] = process.argv.slice(2);
  if (!armId || !seedId) throw new Error("usage: ab-test-generate-arm.ts <armPodcastId> <seedPodcastId> [lastEpisode]");
  const last = Number(lastArg ?? 5);
  const [arm, seed] = await Promise.all([inSeriesOrder(armId), inSeriesOrder(seedId)]);

  const [first, seedFirst] = [arm[0]!, seed[0]!];
  if (first.transcript) {
    log("ep1", "already has a transcript");
  } else {
    if (!seedFirst.transcript) throw new Error("the seed podcast's episode 1 has no transcript");
    await writeEpisode(armId, first.id, {
      transcript: seedFirst.transcript,
      ttsChunks: seedFirst.ttsChunks,
      status: "ready",
      progress: seedFirst.progress,
      error: null,
    });
    log("ep1", "copied from the seed podcast");
  }

  for (let i = 1; i < last; i++) {
    const episode = arm[i]!;
    if (episode.transcript) continue;
    await generate(`C${i + 1}`, armId, episode.id, async (script, patch) => patch(ready(script)));
  }
  log("all", "complete");
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
