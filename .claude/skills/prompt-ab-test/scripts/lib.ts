/**
 * Shared helpers for the prompt/model A/B harness (see ../SKILL.md). Run from
 * the repo root with `npx tsx .claude/skills/prompt-ab-test/scripts/<script>.ts`;
 * the env vars the skill lists must be set (config/env.ts exits without them).
 *
 * `generate` mirrors orchestrator.ts's runEpisodeGeneration, minus voice
 * resolution (billed Voice Design calls that leave orphaned voices behind) and
 * minus the dependents chain (the harness sequences episodes itself). If the
 * experiment changes what the orchestrator passes to generateEpisodeScript,
 * change `buildContext` below the same way — or, better, move that logic into
 * one function in src/ that both call.
 */
import { randomUUID } from "node:crypto";
import { MAX_HISTORY_EPISODES } from "../../../../src/constants/episodeHistory";
import { GENERATION_HEARTBEAT_INTERVAL_MS } from "../../../../src/constants/generationLease";
import { LENGTH_RANGES } from "../../../../src/constants/lengthRanges";
import {
  acquireGenerationLease,
  getEpisode,
  getPriorEpisodes,
  heartbeatGenerationLease,
  listEpisodes,
  patchEpisodeStateAsOwner,
  releaseGenerationLease,
} from "../../../../src/data/episode.repository";
import { getPodcast } from "../../../../src/data/podcast.repository";
import { getSource } from "../../../../src/data/source.repository";
import type { Episode } from "../../../../src/schemas/episode.schema";
import type { Podcast } from "../../../../src/schemas/podcast.schema";
import type { Source } from "../../../../src/schemas/source.schema";
import { chunkTranscript } from "../../../../src/services/episodeGeneration/chunker";
import { generateEpisodeScript, type EpisodeScript } from "../../../../src/services/episodeGeneration/scriptGeneration.service";
import { selectCast } from "../../../../src/services/episodeGeneration/speakerSelection";

export const log = (label: string, msg: string) => console.log(`[${new Date().toISOString()}] ${label}: ${msg}`);

/** An arm's episodes in series order (createdAt, then id), the order history is built in. */
export async function inSeriesOrder(podcastId: string): Promise<Episode[]> {
  return (await listEpisodes(podcastId)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** "Armchair Travel Diaries (Test D)" -> "D", for log lines. */
export async function armLabel(podcastId: string): Promise<string> {
  return (await getPodcast(podcastId))?.title.match(/\(Test (\w+)\)/)?.[1] ?? podcastId.slice(0, 6);
}

/** What orchestrator.ts hands to generateEpisodeScript for this episode. Keep in step with it. */
async function buildContext(podcast: Podcast, episode: Episode, sources: Source[]) {
  const previousEpisodes = await getPriorEpisodes(podcast.id, { id: episode.id, createdAt: episode.createdAt }, MAX_HISTORY_EPISODES);
  return { podcast, episode, sources, previousEpisodes };
}

/** The fields a finished script writes, as orchestrator.ts does. */
export const ready = (script: EpisodeScript): Partial<Episode> => ({
  transcript: script.transcript,
  ttsChunks: chunkTranscript(script.transcript),
  status: "ready",
  progress: { stage: "done", currentWordCount: script.wordCount },
  error: null,
});

/** Writes `fields` to an episode nothing else is generating (takes and releases its lease). */
export async function writeEpisode(podcastId: string, episodeId: string, fields: Partial<Episode>): Promise<void> {
  const owner = randomUUID();
  if (!(await acquireGenerationLease(podcastId, episodeId, owner))) throw new Error("lease held elsewhere");
  try {
    await patchEpisodeStateAsOwner(podcastId, episodeId, owner, fields);
  } finally {
    await releaseGenerationLease(podcastId, episodeId, owner);
  }
}

/**
 * Generates one episode's script and saves it. Holds the generation lease the
 * whole time so a deployed server whose status poll finds a "generating"
 * episode with no lease doesn't start a second run. Marks the episode failed
 * (and rethrows) if the script call fails.
 */
export async function generate(label: string, podcastId: string, episodeId: string): Promise<EpisodeScript> {
  const owner = randomUUID();
  if (!(await acquireGenerationLease(podcastId, episodeId, owner))) throw new Error(`${label}: lease held elsewhere`);
  const heartbeat = setInterval(
    () => heartbeatGenerationLease(podcastId, episodeId, owner).catch(() => {}),
    GENERATION_HEARTBEAT_INTERVAL_MS,
  );
  const patch = (f: Partial<Episode>) => patchEpisodeStateAsOwner(podcastId, episodeId, owner, f);
  try {
    const podcast = (await getPodcast(podcastId))!;
    const episode = (await getEpisode(podcastId, episodeId))!;
    const cast = selectCast(podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id)), episode.guests);
    const sources = (await Promise.all(episode.sourceIds.map((id) => getSource(podcastId, id)))).filter((s) => s !== null);
    const wordTarget = LENGTH_RANGES[episode.length];
    const ctx = await buildContext(podcast, episode, sources);
    log(label, `start (${ctx.previousEpisodes.length} prior transcripts)`);
    const t0 = Date.now();
    const script = await generateEpisodeScript(cast, ctx, wordTarget);
    await patch(ready(script));
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
