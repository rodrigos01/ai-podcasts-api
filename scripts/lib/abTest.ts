import { randomUUID } from "node:crypto";
import { LENGTH_RANGES } from "../../src/constants/lengthRanges";
import { GENERATION_HEARTBEAT_INTERVAL_MS } from "../../src/constants/generationLease";
import {
  acquireGenerationLease,
  getEpisode,
  heartbeatGenerationLease,
  listEpisodes,
  patchEpisodeStateAsOwner,
  releaseGenerationLease,
} from "../../src/data/episode.repository";
import type { Episode } from "../../src/schemas/episode.schema";
import { getPodcast } from "../../src/data/podcast.repository";
import { getSource } from "../../src/data/source.repository";
import { historyMethodOf, resolveScriptContinuity } from "../../src/services/episodeGeneration/continuity";
import { chunkTranscript } from "../../src/services/episodeGeneration/chunker";
import { generateEpisodeScript, type EpisodeScript } from "../../src/services/episodeGeneration/scriptGeneration.service";
import { selectCast } from "../../src/services/episodeGeneration/speakerSelection";

/** Shared by the A/B-test scripts: generates an episode's script outside the server, mirroring orchestrator.ts. */
export const log = (label: string, msg: string) => console.log(`[${new Date().toISOString()}] ${label}: ${msg}`);

export async function inSeriesOrder(podcastId: string) {
  return (await listEpisodes(podcastId)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Runs the script call for one episode; `save` is called with the result while the lease is held. */
export async function generate(
  label: string,
  podcastId: string,
  episodeId: string,
  save: (script: EpisodeScript & { pastNotes: string | null }, patch: (f: Partial<Episode>) => Promise<void>) => Promise<void>,
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
    const { previousEpisodes, previousInteractionId, pastNotes } = await resolveScriptContinuity(podcast, episode, sources);
    const method = historyMethodOf(podcast);
    log(
      label,
      `start (${method}: ${
        method === "interaction"
          ? `chained from ${previousInteractionId ?? "nothing"}`
          : method === "notes"
            ? `${pastNotes ? pastNotes.length : 0} chars of notes`
            : `${previousEpisodes.length} prior transcripts`
      })`,
    );
    const t0 = Date.now();
    const script = await generateEpisodeScript(cast, { podcast, episode, sources, previousEpisodes, ...(pastNotes ? { pastNotes } : {}) }, wordTarget, previousInteractionId);
    await save({ ...script, pastNotes: pastNotes ?? null }, patch);
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

export const ready = (script: EpisodeScript & { pastNotes?: string | null }): Partial<Episode> => ({
  transcript: script.transcript,
  ttsChunks: chunkTranscript(script.transcript),
  interactionId: script.interactionId,
  ...(script.pastNotes ? { pastNotes: script.pastNotes } : {}),
  status: "ready",
  progress: { stage: "done", currentWordCount: script.wordCount },
  error: null,
});

/** Writes `fields` to an episode that nothing else is generating. */
export async function writeEpisode(podcastId: string, episodeId: string, fields: Partial<Episode>) {
  const owner = randomUUID();
  if (!(await acquireGenerationLease(podcastId, episodeId, owner))) throw new Error("lease held elsewhere");
  try {
    await patchEpisodeStateAsOwner(podcastId, episodeId, owner, fields);
  } finally {
    await releaseGenerationLease(podcastId, episodeId, owner);
  }
}

