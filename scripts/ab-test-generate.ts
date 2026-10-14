/**
 * One-off: generates the first N episodes' transcripts for the interaction-
 * context A/B test (see ab-test-setup.ts).
 *
 *  1. Episode 1 is generated once and saved to both podcasts (neither arm has
 *     any history for it, so it's the shared baseline). It runs through B's
 *     path, so its interaction is stored; the id is saved on both episodes.
 *  2. Episodes 2..N are generated in pairs, [A_i, B_i] in parallel, in order —
 *     A with manual history, B chained from the previous interaction.
 *
 * Mirrors orchestrator.ts minus voice resolution and the dependents chain (see
 * lib/abTest.ts). Resumable: episodes that already have a transcript are skipped.
 *
 *   npx tsx scripts/ab-test-generate.ts <podcastAId> <podcastBId> [lastEpisode=5]
 */
import type { Episode } from "../src/schemas/episode.schema";
import { generate, inSeriesOrder, log, ready, writeEpisode } from "./lib/abTest";

async function main() {
  const [aId, bId, lastArg] = process.argv.slice(2);
  if (!aId || !bId) throw new Error("usage: ab-test-generate.ts <podcastAId> <podcastBId> [lastEpisode]");
  const last = Number(lastArg ?? 5);
  const [aEps, bEps] = await Promise.all([inSeriesOrder(aId), inSeriesOrder(bId)]);

  // Episode 1: one generation (through B's interaction path), saved to both.
  const [a1, b1] = [aEps[0]!, bEps[0]!];
  if (a1.transcript && b1.transcript) {
    log("ep1", "already has transcripts in both");
  } else {
    const have = a1.transcript ? a1 : b1.transcript ? b1 : null;
    if (have) {
      log("ep1", "one side already has a transcript; copying it to the other");
      const fields: Partial<Episode> = {
        transcript: have.transcript,
        ttsChunks: have.ttsChunks,
        interactionId: have.interactionId ?? null,
        status: "ready",
        progress: have.progress,
        error: null,
      };
      await writeEpisode(aId, a1.id, fields);
      await writeEpisode(bId, b1.id, fields);
    } else {
      await generate("ep1", bId, b1.id, async (script, patch) => {
        await patch(ready(script));
        await writeEpisode(aId, a1.id, ready(script));
      });
    }
  }

  for (let i = 1; i < last; i++) {
    const [a, b] = [aEps[i]!, bEps[i]!];
    const label = `ep${i + 1}`;
    const jobs = [
      a.transcript ? null : generate(`A${i + 1}`, aId, a.id, async (s, patch) => patch(ready(s))),
      b.transcript ? null : generate(`B${i + 1}`, bId, b.id, async (s, patch) => patch(ready(s))),
    ];
    const results = await Promise.allSettled(jobs.filter((j) => j !== null));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) throw new Error(`${label} failed: ${failed.map((r) => (r as PromiseRejectedResult).reason?.message).join("; ")}`);
  }
  log("all", "complete");
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
