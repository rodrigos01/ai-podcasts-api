/**
 * Generates the first N episodes of one or more arms. Episode 1 is copied from
 * `seedPodcast` so every arm shares the same baseline; if the seed's episode 1
 * has no transcript yet it is generated once, in the first arm, and that one is
 * used (the seed can be any podcast id, e.g. the first arm's own). Episodes
 * 2..N then run in lockstep: for each episode, every
 * arm generates in parallel, and the next episode starts when all have finished
 * (each episode needs its predecessor's transcript for history). Resumable:
 * episodes that already have a transcript are skipped. Stops at the first
 * episode on which any arm fails.
 *
 *   npx tsx .claude/skills/prompt-ab-test/scripts/generate-arms.ts <seedPodcastId> <lastEpisode> <armId> [<armId> ...]
 */
import { armLabel, generate, inSeriesOrder, log, writeEpisode } from "./lib";

async function main() {
  const [seedId, lastArg, ...armIds] = process.argv.slice(2);
  if (!seedId || !lastArg || armIds.length === 0) {
    throw new Error("usage: generate-arms.ts <seedPodcastId> <lastEpisode> <armId> [<armId> ...]");
  }
  const last = Number(lastArg);
  const seed = await inSeriesOrder(seedId);
  const arms = await Promise.all(
    armIds.map(async (id) => ({ id, label: await armLabel(id), episodes: await inSeriesOrder(id) })),
  );

  let seedFirst = seed[0]!;
  if (!seedFirst.transcript) {
    const [firstArm] = arms;
    const first = firstArm!.episodes[0]!;
    if (!first.transcript) await generate(`${firstArm!.label}1`, firstArm!.id, first.id);
    seedFirst = (await inSeriesOrder(firstArm!.id))[0]!;
  }
  for (const arm of arms) {
    const first = arm.episodes[0]!;
    if (first.transcript) continue;
    await writeEpisode(arm.id, first.id, {
      transcript: seedFirst.transcript,
      ttsChunks: seedFirst.ttsChunks,
      status: "ready",
      progress: seedFirst.progress,
      error: null,
    });
    log(`${arm.label}1`, "copied from the seed podcast");
  }

  for (let i = 1; i < last; i++) {
    const results = await Promise.allSettled(
      arms
        .filter((arm) => !arm.episodes[i]!.transcript)
        .map((arm) => generate(`${arm.label}${i + 1}`, arm.id, arm.episodes[i]!.id)),
    );
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) throw new Error(`episode ${i + 1} failed: ${failed.map((r) => r.reason?.message ?? r.reason).join("; ")}`);
  }
  log("all", "complete");
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
