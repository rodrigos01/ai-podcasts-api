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
 * Mirrors orchestrator.ts minus voice resolution and the dependents chain (audio
 * isn't needed, and the pairs are sequenced here). Resumable: episodes that
 * already have a transcript are skipped.
 *
 *   npx tsx scripts/ab-test-generate.ts <podcastAId> <podcastBId> [lastEpisode=5]
 */
import { randomUUID } from "node:crypto";
import { LENGTH_RANGES } from "../src/constants/lengthRanges";
import { GENERATION_HEARTBEAT_INTERVAL_MS } from "../src/constants/generationLease";
import {
  acquireGenerationLease,
  getEpisode,
  heartbeatGenerationLease,
  listEpisodes,
  patchEpisodeStateAsOwner,
  releaseGenerationLease,
} from "../src/data/episode.repository";
import type { Episode } from "../src/schemas/episode.schema";
import { getPodcast } from "../src/data/podcast.repository";
import { getSource } from "../src/data/source.repository";
import { resolveScriptContinuity } from "../src/services/episodeGeneration/continuity";
import { chunkTranscript } from "../src/services/episodeGeneration/chunker";
import { generateEpisodeScript, type EpisodeScript } from "../src/services/episodeGeneration/scriptGeneration.service";
import { selectCast } from "../src/services/episodeGeneration/speakerSelection";

const log = (label: string, msg: string) => console.log(`[${new Date().toISOString()}] ${label}: ${msg}`);

async function inSeriesOrder(podcastId: string) {
  return (await listEpisodes(podcastId)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Runs the script call for one episode; `save` is called with the result while the lease is held. */
async function generate(
  label: string,
  podcastId: string,
  episodeId: string,
  save: (script: EpisodeScript, patch: (f: Partial<Episode>) => Promise<void>) => Promise<void>,
): Promise<EpisodeScript> {
  const owner = randomUUID();
  if (!(await acquireGenerationLease(podcastId, episodeId, owner))) throw new Error(`${label}: lease held elsewhere`);
  const heartbeat = setInterval(() => heartbeatGenerationLease(podcastId, episodeId, owner).catch(() => {}), GENERATION_HEARTBEAT_INTERVAL_MS);
  const patch = (f: Partial<Episode>) => patchEpisodeStateAsOwner(podcastId, episodeId, owner, f);
  try {
    const podcast = (await getPodcast(podcastId))!;
    const episode = (await getEpisode(podcastId, episodeId))!;
    const hosts = podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id));
    const cast = selectCast(hosts, episode.guests);
    const sources = (await Promise.all(episode.sourceIds.map((id) => getSource(podcastId, id)))).filter((s) => s !== null);
    const wordTarget = LENGTH_RANGES[episode.length];
    const { previousEpisodes, previousInteractionId } = await resolveScriptContinuity(podcast, episode);
    log(
      label,
      `start (${podcast.useInteractionContext ? `chained from ${previousInteractionId ?? "nothing"}` : `${previousEpisodes.length} prior transcripts`})`,
    );
    const t0 = Date.now();
    const script = await generateEpisodeScript(cast, { podcast, episode, sources, previousEpisodes }, wordTarget, previousInteractionId);
    await save(script, patch);
    log(label, `done: ${script.wordCount} words (target ${wordTarget.min}-${wordTarget.max}) in ${Math.round((Date.now() - t0) / 1000)}s`);
    return script;
  } catch (err) {
    await patch({ status: "failed", error: err instanceof Error ? err.message : String(err) }).catch(() => {});
    throw err;
  } finally {
    clearInterval(heartbeat);
    await releaseGenerationLease(podcastId, episodeId, owner).catch(() => {});
  }
}

const ready = (script: EpisodeScript): Partial<Episode> => ({
  transcript: script.transcript,
  ttsChunks: chunkTranscript(script.transcript),
  interactionId: script.interactionId,
  status: "ready",
  progress: { stage: "done", currentWordCount: script.wordCount },
  error: null,
});

/** Writes `fields` to an episode that nothing else is generating. */
async function writeEpisode(podcastId: string, episodeId: string, fields: Partial<Episode>) {
  const owner = randomUUID();
  if (!(await acquireGenerationLease(podcastId, episodeId, owner))) throw new Error("lease held elsewhere");
  try {
    await patchEpisodeStateAsOwner(podcastId, episodeId, owner, fields);
  } finally {
    await releaseGenerationLease(podcastId, episodeId, owner);
  }
}

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
