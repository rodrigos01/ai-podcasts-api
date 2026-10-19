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
 *   npx tsx .../generate-arms.ts --only <n> <seedPodcastId> <armId> [<armId> ...]
 *
 * With `--only n`, episodes 1..n-1 are copied from the seed (which must have
 * their transcripts) so every arm has the same history, and only episode n is
 * generated — for a costly variant that is tried on one representative episode.
 */
import { armLabel, generate, inSeriesOrder, log, writeEpisode } from "./lib";

async function main() {
  let args = process.argv.slice(2);
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? Number(args[onlyAt + 1]) : null;
  if (onlyAt >= 0) args = args.filter((_, i) => i !== onlyAt && i !== onlyAt + 1);
  const [seedId, ...rest] = args;
  const lastArg = only ? String(only) : rest.shift();
  const armIds = rest;
  if (!seedId || !lastArg || armIds.length === 0) {
    throw new Error("usage: generate-arms.ts <seedPodcastId> <lastEpisode> <armId>...  |  --only <n> <seedPodcastId> <armId>...");
  }
  const last = Number(lastArg);
  const seed = await inSeriesOrder(seedId);
  const arms = await Promise.all(
    armIds.map(async (id) => ({ id, label: await armLabel(id), episodes: await inSeriesOrder(id) })),
  );

  let seedFirst = seed[0]!;
  if (only) {
    // Pre-fill episodes 1..n-1 in every arm from the seed, so all arms share the same history.
    for (let i = 0; i < only - 1; i++) {
      const from = seed[i];
      if (!from?.transcript) throw new Error(`--only ${only}: the seed has no transcript for episode ${i + 1}`);
      for (const arm of arms) {
        const target = arm.episodes[i]!;
        if (target.transcript) continue;
        await writeEpisode(arm.id, target.id, {
          transcript: from.transcript,
          ttsChunks: from.ttsChunks,
          status: "ready",
          progress: from.progress,
          error: null,
        });
        log(`${arm.label}${i + 1}`, "copied from the seed podcast");
      }
    }
  }
  if (!only && !seedFirst.transcript) {
    const [firstArm] = arms;
    const first = firstArm!.episodes[0]!;
    if (!first.transcript) await generate(`${firstArm!.label}1`, firstArm!.id, first.id);
    seedFirst = (await inSeriesOrder(firstArm!.id))[0]!;
  }
  for (const arm of only ? [] : arms) {
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

  for (let i = only ? only - 1 : 1; i < last; i++) {
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
