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
 *   npx tsx .../generate-arms.ts --from <n> <seedPodcastId> <lastEpisode> <armId> [<armId> ...]
 *
 * With `--only n` / `--from n`, episodes 1..n-1 are copied from the seed (which
 * must have their transcripts) so every arm has the same history, and generation
 * starts at episode n: `--only` stops there too (a costly variant tried on one
 * representative episode), `--from` runs on to `lastEpisode`. The seed can be
 * an existing arm whose later episodes already serve as the control.
 */
import { armLabel, generate, inSeriesOrder, log, writeEpisode } from "./lib";

async function main() {
  let args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(name);
    if (at < 0) return null;
    const value = Number(args[at + 1]);
    args = args.filter((_, i) => i !== at && i !== at + 1);
    return value;
  };
  const onlyFlag = flag("--only");
  const fromFlag = flag("--from");
  const prefillTo = onlyFlag ?? fromFlag; // episodes 1..prefillTo-1 come from the seed
  const [seedId, ...rest] = args;
  const lastArg = onlyFlag ? String(onlyFlag) : rest.shift();
  const armIds = rest;
  if (!seedId || !lastArg || armIds.length === 0) {
    throw new Error("usage: generate-arms.ts [--only n | --from n] <seedPodcastId> [<lastEpisode>] <armId>...");
  }
  const last = Number(lastArg);
  const seed = await inSeriesOrder(seedId);
  const arms = await Promise.all(
    armIds.map(async (id) => ({ id, label: await armLabel(id), episodes: await inSeriesOrder(id) })),
  );

  let seedFirst = seed[0]!;
  const startAt = prefillTo;
  if (startAt) {
    // Pre-fill episodes 1..n-1 in every arm from the seed, so all arms share the same history.
    for (let i = 0; i < startAt - 1; i++) {
      const from = seed[i];
      if (!from?.transcript) throw new Error(`--only/--from ${startAt}: the seed has no transcript for episode ${i + 1}`);
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
  if (!startAt && !seedFirst.transcript) {
    const [firstArm] = arms;
    const first = firstArm!.episodes[0]!;
    if (!first.transcript) await generate(`${firstArm!.label}1`, firstArm!.id, first.id);
    seedFirst = (await inSeriesOrder(firstArm!.id))[0]!;
  }
  for (const arm of startAt ? [] : arms) {
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

  for (let i = startAt ? startAt - 1 : 1; i < last; i++) {
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
