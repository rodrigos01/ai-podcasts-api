import type { Response } from "express";
import { streamEpisodeSynthesis, type TtsVoiceAssignment } from "../llm/ttsClient";
import {
  createFinalAudioReadStream,
  getCachedChunk,
  getCachedChunkSize,
  getFinalAudioSize,
  putCachedChunk,
} from "../storage/audioCache.repository";
import { releaseChunkLock, tryAcquireChunkLock } from "../data/audioLock.repository";
import { bumpGeneratedAudioSeconds } from "../data/episode.repository";
import { CHUNK_LOCK_POLL_INTERVAL_MS } from "../constants/ttsLimits";
import type { Episode, TtsChunk } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { speakerLabel } from "./episodeGeneration/speakerSelection";
import { resolveGuestVoice, resolveHostVoice } from "./episodeGeneration/voiceResolution.service";
import { finalizeEpisodeAudio } from "./episodeGeneration/audioFinalize.service";
import { chunkTranscript } from "./episodeGeneration/chunker";
import { parseScriptTurns, type ScriptTurn } from "../utils/scriptText";
import { buildStreamingWavHeader, buildWav, buildWavHeader, DEFAULT_PCM_FORMAT, durationSeconds, secondsToByteOffset } from "../utils/wav";
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

/** Writes the portion of `data` (starting at absolute PCM offset `dataStart`) that's at or past `targetStart`. */
function writeSlice(res: Response, data: Buffer, dataStart: number, targetStart: number): void {
  if (res.destroyed || res.writableEnded) return;
  if (targetStart < dataStart + data.length) {
    res.write(data.subarray(Math.max(0, targetStart - dataStart)));
  }
}

/**
 * Serves a fully-generated episode's `final.ogg` as a normal, fully
 * seekable static resource — real `Content-Length`, honors a real `Range`
 * request with `206`/`Content-Range`.
 */
function serveFinalAudio(
  podcastId: string,
  episodeId: string,
  size: number,
  res: Response,
  rangeStart: number | null,
): void {
  res.set("Content-Type", "audio/ogg");
  res.set("Accept-Ranges", "bytes");

  if (rangeStart !== null) {
    if (rangeStart >= size) {
      throw new HttpError(416, "Range Not Satisfiable");
    }
    res.status(206);
    res.set("Content-Range", `bytes ${rangeStart}-${size - 1}/${size}`);
    res.set("Content-Length", String(size - rangeStart));
    createFinalAudioReadStream(podcastId, episodeId, { start: rangeStart }).pipe(res);
    return;
  }

  res.status(200);
  res.set("Content-Length", String(size));
  createFinalAudioReadStream(podcastId, episodeId).pipe(res);
}

/** In-flight finalizations deduplication to prevent duplicate ffmpeg encoding */
const inFlightFinalizations = new Map<string, Promise<void>>();

function finalizeFromCachedChunks(
  podcastId: string,
  episodeId: string,
  chunks: TtsChunk[],
): Promise<void> {
  const key = `${podcastId}:${episodeId}`;
  const existing = inFlightFinalizations.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const finalSize = await getFinalAudioSize(podcastId, episodeId);
      if (finalSize !== null) return;
      const buffers = await Promise.all(
        chunks.map((_, i) => getCachedChunk(podcastId, episodeId, i)),
      );
      if (buffers.some((b) => b === null)) return;
      const fullPcm = Buffer.concat(buffers as Buffer[]);
      await finalizeEpisodeAudio(podcastId, episodeId, fullPcm);
    } catch (err) {
      console.error(`Failed to finalize episode audio for ${podcastId}/${episodeId}:`, err);
    }
  })();

  inFlightFinalizations.set(key, promise);
  promise.finally(() => inFlightFinalizations.delete(key));
  return promise;
}

/** In-flight generation promises on this process instance */
const inFlightGenerations = new Map<string, Promise<Buffer>>();

function chunkKey(podcastId: string, episodeId: string, index: number): string {
  return `${podcastId}:${episodeId}:${index}`;
}

/**
 * Generates one chunk (or waits for another instance currently generating it).
 * Uses Firestore chunk locking for cross-instance coordination.
 */
async function generateOrJoinChunk(
  podcastId: string,
  episodeId: string,
  index: number,
  chunkTurns: ScriptTurn[],
  voices: TtsVoiceAssignment[],
  chunkStart: number,
  onDelta: (delta: Buffer) => void,
): Promise<Buffer> {
  for (;;) {
    const acquired = await tryAcquireChunkLock(podcastId, episodeId, index);
    if (acquired) {
      try {
        const parts: Buffer[] = [];
        await streamEpisodeSynthesis(chunkTurns, voices, (delta) => {
          parts.push(delta);
          onDelta(delta);
        });
        const fullChunk = Buffer.concat(parts);
        await putCachedChunk(podcastId, episodeId, index, fullChunk);
        await bumpGeneratedAudioSeconds(
          podcastId,
          episodeId,
          durationSeconds(DEFAULT_PCM_FORMAT, chunkStart + fullChunk.length),
        );
        return fullChunk;
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
  chunkStart: number,
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
    chunkStart,
    onDelta,
  );

  inFlightGenerations.set(key, promise);
  promise.finally(() => inFlightGenerations.delete(key));
  return { promise, isLeader: true };
}

/**
 * Streams an episode's audio chunk by chunk as a continuous WAV stream.
 *
 * Seeking:
 * - Supports `Range: bytes=START-` header (byte-offset space) and `?t=SECONDS` query param.
 * - If seeking within already-cached chunks, previous chunks are skipped or sliced accordingly.
 * - Transitions seamlessly from already-cached chunk audio to live-generating audio.
 * - Once all chunks exist, encodes to `final.ogg` in the background for permanent static delivery.
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

  const finalSize = await getFinalAudioSize(podcastId, episodeId);
  if (finalSize !== null) {
    serveFinalAudio(podcastId, episodeId, finalSize, res, seek.rangeStart);
    return;
  }

  const chunks =
    episode.ttsChunks && episode.ttsChunks.length > 0
      ? episode.ttsChunks
      : chunkTranscript(episode.transcript);

  const voices = await resolveCastVoices(podcastId, episodeId, podcast, episode);

  const isByteRangeRequest = seek.rangeStart !== null;
  let targetPcmOffset = 0;
  if (seek.startTimeSeconds !== null) {
    targetPcmOffset = secondsToByteOffset(DEFAULT_PCM_FORMAT, seek.startTimeSeconds);
  } else if (seek.rangeStart !== null) {
    targetPcmOffset = Math.max(0, seek.rangeStart - 44);
    targetPcmOffset -= targetPcmOffset % 2; // align to 16-bit PCM frame (2 bytes)
  }

  const cachedSizes = await Promise.all(
    chunks.map((_, i) => getCachedChunkSize(podcastId, episodeId, i)),
  );
  const allCached = chunks.length > 0 && cachedSizes.every((s) => s !== null);

  // When all chunks are already cached, total length is known: serve as seekable resource
  if (allCached) {
    const totalPcmBytes = cachedSizes.reduce((sum, s) => sum + (s ?? 0), 0);
    const fullResourceLength = 44 + totalPcmBytes;

    if (isByteRangeRequest && seek.rangeStart !== null) {
      if (seek.rangeStart >= fullResourceLength) {
        throw new HttpError(416, "Range Not Satisfiable");
      }
      res.status(206);
      res.set("Content-Type", "audio/wav");
      res.set("Accept-Ranges", "bytes");
      res.set("Content-Range", `bytes ${seek.rangeStart}-${fullResourceLength - 1}/${fullResourceLength}`);
      res.set("Content-Length", String(fullResourceLength - seek.rangeStart));

      if (seek.rangeStart < 44) {
        const header = buildWavHeader(DEFAULT_PCM_FORMAT, totalPcmBytes);
        res.write(header.subarray(seek.rangeStart));
      }

      let pos = 0;
      for (let i = 0; i < chunks.length; i++) {
        const data = await getCachedChunk(podcastId, episodeId, i);
        if (data) {
          writeSlice(res, data, pos, targetPcmOffset);
          pos += data.length;
        }
      }
      res.end();
      void finalizeFromCachedChunks(podcastId, episodeId, chunks);
      return;
    }

    res.status(200);
    res.set("Content-Type", "audio/wav");
    res.set("Accept-Ranges", "bytes");

    if (seek.startTimeSeconds !== null) {
      const remainingPcm = Math.max(0, totalPcmBytes - targetPcmOffset);
      res.set("Content-Length", String(44 + remainingPcm));
      res.write(buildWavHeader(DEFAULT_PCM_FORMAT, remainingPcm));
    } else {
      res.set("Content-Length", String(fullResourceLength));
      res.write(buildWavHeader(DEFAULT_PCM_FORMAT, totalPcmBytes));
    }

    let pos = 0;
    for (let i = 0; i < chunks.length; i++) {
      const data = await getCachedChunk(podcastId, episodeId, i);
      if (data) {
        writeSlice(res, data, pos, targetPcmOffset);
        pos += data.length;
      }
    }
    res.end();
    void finalizeFromCachedChunks(podcastId, episodeId, chunks);
    return;
  }

  // Live streaming path: chunked transfer (unknown total length)
  // NEVER return Content-Length while chunks are still generating (chunked transfer only)
  if (typeof res.removeHeader === "function") {
    res.removeHeader("Content-Length");
  }
  res.set("Content-Type", "audio/wav");
  res.set("Accept-Ranges", "bytes");
  res.status(200);

  // If a client sent a Range request while chunks are still generating, we cannot honor
  // it with a 206 (total length is unknown), so per HTTP spec, we stream the full resource
  // from byte 0 with a plain 200 (including WAV header), and the client self-skips.
  // For ?t= resume, bodyStart is targetPcmOffset (skipping already-generated chunks).
  const bodyStart = isByteRangeRequest ? 0 : targetPcmOffset;

  // The streaming WAV header is written once, unconditionally, at the start of the 200 response
  res.write(buildStreamingWavHeader(DEFAULT_PCM_FORMAT));

  let stopped = false;
  res.on("close", () => {
    stopped = true;
  });

  let pos = 0;
  for (let index = 0; index < chunks.length && !stopped; index++) {
    const chunk = chunks[index];
    if (!chunk) continue;
    const chunkStart = pos;

    const cachedSize = cachedSizes[index] ?? (await getCachedChunkSize(podcastId, episodeId, index));
    if (cachedSize !== null) {
      if (bodyStart < chunkStart + cachedSize) {
        const data = await getCachedChunk(podcastId, episodeId, index);
        if (data) {
          writeSlice(res, data, chunkStart, bodyStart);
          pos = chunkStart + data.length;
        } else {
          pos = chunkStart + cachedSize;
        }
      } else {
        pos = chunkStart + cachedSize;
      }
      continue;
    }

    // Chunk is NOT cached — transition to live generation
    const chunkTurns = parseScriptTurns(episode.transcript.slice(chunk.startOffset, chunk.endOffset));
    let emittedInChunk = 0;

    const { promise, isLeader } = getOrStartChunkGeneration(
      podcastId,
      episodeId,
      index,
      chunkTurns,
      voices,
      chunkStart,
      (delta) => {
        writeSlice(res, delta, chunkStart + emittedInChunk, bodyStart);
        emittedInChunk += delta.length;
      },
    );

    try {
      const fullChunk = await promise;
      if (!isLeader) {
        writeSlice(res, fullChunk, chunkStart, bodyStart);
      }
      pos = chunkStart + fullChunk.length;
    } catch (err) {
      console.error(`Chunk ${index} generation failed for ${podcastId}/${episodeId}:`, err);
      throw err;
    }
  }

  if (!stopped) {
    void finalizeFromCachedChunks(podcastId, episodeId, chunks);
  }
  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }
}
