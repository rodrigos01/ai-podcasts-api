import type { Response } from "express";
import { streamEpisodeSynthesis, type TtsVoiceAssignment } from "../llm/ttsClient";
import {
  getCachedChunk,
  getCachedChunkSize,
  putCachedChunk,
} from "../storage/audioCache.repository";
import { releaseChunkLock, tryAcquireChunkLock } from "../data/audioLock.repository";
import { bumpGeneratedAudioSeconds } from "../data/episode.repository";
import { CHUNK_LOCK_POLL_INTERVAL_MS } from "../constants/ttsLimits";
import type { Episode } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { speakerLabel } from "./episodeGeneration/speakerSelection";
import { resolveGuestVoice, resolveHostVoice } from "./episodeGeneration/voiceResolution.service";
import { finalizeEpisodeAudio } from "./episodeGeneration/audioFinalize.service";
import { chunkTranscript } from "./episodeGeneration/chunker";
import { parseScriptTurns, type ScriptTurn } from "../utils/scriptText";
import { DEFAULT_PCM_FORMAT, durationSeconds } from "../utils/wav";
import { createAacStreamEncoder, encodePcmToAac, getAdtsDurationSeconds } from "../utils/aac";
import { HttpError } from "../utils/HttpError";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks that the episode is in a state where audio can be streamed.
 * Generation failure or missing transcript blocks playback.
 */
function assertAudioAvailable(episode: Episode): asserts episode is Episode & { transcript: string } {
  if (episode.status === "failed") {
    throw HttpError.badRequest("Episode generation failed");
  }
  if (!episode.transcript) {
    throw HttpError.badRequest("Episode audio is not ready yet");
  }
}

/**
 * Resolves both cast members' TTS voices. The normal path reads persisted
 * `resolvedVoiceId` values; falls back to resolving lazily if missing.
 */
async function resolveCastVoices(
  podcastId: string,
  episodeId: string,
  podcast: Podcast,
  episode: Episode,
): Promise<TtsVoiceAssignment[]> {
  const hosts = podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id));
  const hostIds = new Set(hosts.map((h) => h.id));
  const cast = [...hosts, ...episode.guests];
  const [p1, p2] = cast;
  if (!p1 || !p2) {
    throw new Error(`Expected exactly 2 cast members for episode ${episodeId}, got ${cast.length}`);
  }

  const assignments: TtsVoiceAssignment[] = [];
  for (const [person, other] of [
    [p1, p2],
    [p2, p1],
  ] as const) {
    const resolved = hostIds.has(person.id)
      ? await resolveHostVoice(podcastId, person)
      : person.resolvedVoiceId
        ? { voiceId: person.resolvedVoiceId }
        : await resolveGuestVoice(podcastId, episodeId, person);
    assignments.push({
      label: speakerLabel(person.name, other.name),
      voiceId: resolved.voiceId,
      languageCode: resolved.languageCode,
    });
  }
  return assignments;
}

/** In-flight generation promises on this process instance */
const inFlightGenerations = new Map<string, Promise<Buffer>>();

function chunkKey(podcastId: string, episodeId: string, index: number): string {
  return `${podcastId}:${episodeId}:${index}`;
}

/**
 * Generates one chunk (or waits for another instance currently generating it).
 * Streams PCM deltas in real-time through an ffmpeg AAC encoder so the listener
 * receives audio within milliseconds, while accumulating the full AAC chunk for caching.
 * Uses Firestore chunk locking for cross-instance coordination.
 */
async function generateOrJoinChunk(
  podcastId: string,
  episodeId: string,
  index: number,
  chunkTurns: ScriptTurn[],
  voices: TtsVoiceAssignment[],
  chunkStartSeconds: number,
  onDelta: (delta: Buffer) => void,
): Promise<Buffer> {
  for (;;) {
    const acquired = await tryAcquireChunkLock(podcastId, episodeId, index);
    if (acquired) {
      const encoder = createAacStreamEncoder(onDelta);
      try {
        let totalPcmBytes = 0;
        await streamEpisodeSynthesis(chunkTurns, voices, (pcmDelta) => {
          totalPcmBytes += pcmDelta.length;
          encoder.write(pcmDelta);
        });
        const fullAac = await encoder.end();
        await putCachedChunk(podcastId, episodeId, index, fullAac);
        const chunkSec = durationSeconds(DEFAULT_PCM_FORMAT, totalPcmBytes);
        await bumpGeneratedAudioSeconds(
          podcastId,
          episodeId,
          chunkStartSeconds + chunkSec,
        );
        return fullAac;
      } catch (err) {
        encoder.destroy(err instanceof Error ? err : undefined);
        throw err;
      } finally {
        await releaseChunkLock(podcastId, episodeId, index);
      }
    }

    // Another instance holds the lock — wait for it to land in the cache
    const cached = await getCachedChunk(podcastId, episodeId, index);
    if (cached) {
      onDelta(cached);
      return cached;
    }
    await sleep(CHUNK_LOCK_POLL_INTERVAL_MS);
  }
}

function getOrStartChunkGeneration(
  podcastId: string,
  episodeId: string,
  index: number,
  chunkTurns: ScriptTurn[],
  voices: TtsVoiceAssignment[],
  chunkStartSeconds: number,
  onDelta: (delta: Buffer) => void,
): { promise: Promise<Buffer>; isLeader: boolean } {
  const key = chunkKey(podcastId, episodeId, index);
  const existing = inFlightGenerations.get(key);
  if (existing) {
    return { promise: existing, isLeader: false };
  }

  const promise = generateOrJoinChunk(
    podcastId,
    episodeId,
    index,
    chunkTurns,
    voices,
    chunkStartSeconds,
    onDelta,
  );

  inFlightGenerations.set(key, promise);
  promise.finally(() => inFlightGenerations.delete(key));
  return { promise, isLeader: true };
}

/**
 * Streams an episode's audio chunk by chunk as an ADTS AAC stream.
 *
 * Seeking:
 * - Supports `Range: bytes=START-` header (byte-offset space) and `?t=SECONDS` query param.
 * - Transitions seamlessly from already-cached chunk audio to live-generating audio.
 * - Each chunk is encoded and cached as ADTS AAC, enabling direct concatenation without container overhead.
 */
export async function streamEpisodeAudio(
  podcastId: string,
  episodeId: string,
  episode: Episode,
  podcast: Podcast,
  res: Response,
  seek: { rangeStart: number | null; startTimeSeconds: number | null },
): Promise<void> {
  assertAudioAvailable(episode);

  const chunks =
    episode.ttsChunks && episode.ttsChunks.length > 0
      ? episode.ttsChunks
      : chunkTranscript(episode.transcript);

  const voices = await resolveCastVoices(podcastId, episodeId, podcast, episode);

  const cachedSizes = await Promise.all(
    chunks.map((_, i) => getCachedChunkSize(podcastId, episodeId, i)),
  );
  const allCached = chunks.length > 0 && cachedSizes.every((s) => s !== null);

  res.set("Content-Type", "audio/aac");
  res.set("Accept-Ranges", "bytes");

  // Path 1: All chunks are cached -> serve seekable static AAC resource
  if (allCached) {
    const totalAacBytes = cachedSizes.reduce((sum, s) => sum + (s ?? 0), 0);

    // Handle HTTP Range request (e.g. Range: bytes=1000- or bytes=0-)
    if (seek.rangeStart !== null) {
      if (seek.rangeStart >= totalAacBytes) {
        throw new HttpError(416, "Range Not Satisfiable");
      }
      res.status(206);
      res.set("Content-Range", `bytes ${seek.rangeStart}-${totalAacBytes - 1}/${totalAacBytes}`);
      res.set("Content-Length", String(totalAacBytes - seek.rangeStart));

      let currentOffset = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunkData = await getCachedChunk(podcastId, episodeId, i);
        if (!chunkData) continue;
        const chunkEnd = currentOffset + chunkData.length;
        if (chunkEnd > seek.rangeStart) {
          const sliceStart = Math.max(0, seek.rangeStart - currentOffset);
          res.write(chunkData.subarray(sliceStart));
        }
        currentOffset = chunkEnd;
      }
      res.end();
      void finalizeEpisodeAudio(podcastId, episodeId);
      return;
    }

    // Handle ?t=SECONDS seek into cached chunks
    if (seek.startTimeSeconds !== null && seek.startTimeSeconds > 0) {
      let cumulativeSec = 0;
      let startChunkIndex = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunkData = await getCachedChunk(podcastId, episodeId, i);
        const dur = chunkData ? getAdtsDurationSeconds(chunkData) : 0;
        if (cumulativeSec + dur > seek.startTimeSeconds) {
          startChunkIndex = i;
          break;
        }
        cumulativeSec += dur;
        startChunkIndex = i;
      }

      const remainingBytes = cachedSizes
        .slice(startChunkIndex)
        .reduce((sum, s) => sum + (s ?? 0), 0);
      res.status(200);
      res.set("Content-Length", String(remainingBytes));

      for (let i = startChunkIndex; i < chunks.length; i++) {
        const chunkData = await getCachedChunk(podcastId, episodeId, i);
        if (chunkData) res.write(chunkData);
      }
      res.end();
      void finalizeEpisodeAudio(podcastId, episodeId);
      return;
    }

    // Fresh 200 OK request for all cached chunks
    res.status(200);
    res.set("Content-Length", String(totalAacBytes));
    for (let i = 0; i < chunks.length; i++) {
      const chunkData = await getCachedChunk(podcastId, episodeId, i);
      if (chunkData) res.write(chunkData);
    }
    res.end();
    void finalizeEpisodeAudio(podcastId, episodeId);
    return;
  }

  // Path 2: Live streaming path (chunks still generating)
  // NEVER return Content-Length while chunks are still generating (chunked transfer only)
  if (typeof res.removeHeader === "function") {
    res.removeHeader("Content-Length");
  }
  res.status(200);

  // Determine starting chunk if ?t=SECONDS was specified
  let startChunkIndex = 0;
  let cumulativeSec = 0;
  if (seek.startTimeSeconds !== null && seek.startTimeSeconds > 0) {
    for (let i = 0; i < chunks.length; i++) {
      const size = cachedSizes[i];
      if (size === null) {
        startChunkIndex = i;
        break;
      }
      const data = await getCachedChunk(podcastId, episodeId, i);
      const dur = data ? getAdtsDurationSeconds(data) : 0;
      if (cumulativeSec + dur > seek.startTimeSeconds) {
        startChunkIndex = i;
        break;
      }
      cumulativeSec += dur;
      startChunkIndex = i;
    }
  }

  let stopped = false;
  res.on("close", () => {
    stopped = true;
  });

  // Calculate cumulative audio seconds up to startChunkIndex
  let runningAudioSeconds = 0;
  for (let i = 0; i < startChunkIndex; i++) {
    const data = await getCachedChunk(podcastId, episodeId, i);
    if (data) {
      runningAudioSeconds += getAdtsDurationSeconds(data);
    }
  }

  for (let index = startChunkIndex; index < chunks.length && !stopped; index++) {
    const chunk = chunks[index];
    if (!chunk) continue;

    const cached = await getCachedChunk(podcastId, episodeId, index);
    if (cached) {
      if (!stopped) res.write(cached);
      runningAudioSeconds += getAdtsDurationSeconds(cached);
      continue;
    }

    // Chunk is NOT cached — live generation
    const chunkTurns = parseScriptTurns(episode.transcript.slice(chunk.startOffset, chunk.endOffset));
    const chunkStartSec = runningAudioSeconds;

    const { promise, isLeader } = getOrStartChunkGeneration(
      podcastId,
      episodeId,
      index,
      chunkTurns,
      voices,
      chunkStartSec,
      (delta) => {
        if (!stopped) res.write(delta);
      },
    );

    try {
      const fullChunk = await promise;
      if (!isLeader && !stopped) {
        res.write(fullChunk);
      }
      runningAudioSeconds += getAdtsDurationSeconds(fullChunk);
    } catch (err) {
      console.error(`Chunk ${index} generation failed for ${podcastId}/${episodeId}:`, err);
      throw err;
    }
  }

  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }

  // Trigger voice cleanup if all chunks are now ready
  const finalCachedSizes = await Promise.all(
    chunks.map((_, i) => getCachedChunkSize(podcastId, episodeId, i)),
  );
  if (finalCachedSizes.every((s) => s !== null)) {
    void finalizeEpisodeAudio(podcastId, episodeId);
  }
}
