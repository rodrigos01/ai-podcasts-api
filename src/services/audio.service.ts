import type { Response } from "express";
import { streamEpisodeSynthesis, type TtsVoiceAssignment } from "../llm/ttsClient";
import {
  getCachedChunk,
  getCachedChunkSize,
  putCachedChunk,
} from "../storage/audioCache.repository";
import { releaseChunkLock, tryAcquireChunkLock } from "../data/audioLock.repository";
import { bumpGeneratedAudioSeconds, markAudioComplete } from "../data/episode.repository";
import { CHUNK_LOCK_POLL_INTERVAL_MS } from "../constants/ttsLimits";
import type { Episode } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { speakerLabel } from "./episodeGeneration/speakerSelection";
import { hasCurrentVoice, resolveGuestVoice, resolveHostVoice } from "./episodeGeneration/voiceResolution.service";
import { finalizeEpisodeAudio } from "./episodeGeneration/audioFinalize.service";
import { chunkTranscript, getChunkTurns } from "./episodeGeneration/chunker";
import type { ScriptTurn } from "../utils/scriptText";
import { DEFAULT_PCM_FORMAT, durationSeconds } from "../utils/wav";
import { createAacStreamEncoder, encodePcmToAac, getAdtsDurationSeconds, sliceAdtsByTime } from "../utils/aac";
import { HttpError } from "../utils/HttpError";
import { createByteSkipper } from "../utils/rangeSkip";

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
 * `resolvedVoiceId` values; a voice that's missing or not current (see
 * voiceResolution.service.ts's hasCurrentVoice — e.g. one stored before the
 * move to the Enterprise Voices API) is designed lazily here instead.
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
      ? await resolveHostVoice(podcastId, person, podcast.languageCode)
      : hasCurrentVoice(person)
        ? { voiceId: person.resolvedVoiceId }
        : await resolveGuestVoice(podcastId, episodeId, person, podcast.languageCode);
    assignments.push({
      label: speakerLabel(person.name, other.name),
      voiceId: resolved.voiceId,
    });
  }
  return assignments;
}

/**
 * Once every chunk is cached the audio is a finished file: records
 * `audioComplete` and its exact duration on the episode so clients can tell
 * "done" from "stream cut short" without inferring it from the stream itself.
 * Cheap while chunks are missing (size lookups only); reads the chunk bodies
 * (to sum their ADTS durations) just once, when the last one lands.
 */
async function recordAudioCompletionIfDone(
  podcastId: string,
  episodeId: string,
  chunkCount: number,
): Promise<void> {
  const sizes = await Promise.all(
    Array.from({ length: chunkCount }, (_, i) => getCachedChunkSize(podcastId, episodeId, i)),
  );
  if (chunkCount === 0 || sizes.some((s) => s === null)) return;

  let totalSeconds = 0;
  for (let i = 0; i < chunkCount; i++) {
    const data = await getCachedChunk(podcastId, episodeId, i);
    if (!data) return;
    totalSeconds += getAdtsDurationSeconds(data);
  }
  await markAudioComplete(podcastId, episodeId, totalSeconds);
}

function recordAudioCompletionInBackground(podcastId: string, episodeId: string, chunkCount: number): void {
  recordAudioCompletionIfDone(podcastId, episodeId, chunkCount).catch((err) => {
    console.error(`Failed to record audio completion for ${podcastId}/${episodeId}:`, err);
  });
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
  chunkCount: number,
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
        // Done here, by the generating instance, rather than at the end of a
        // /stream request: the listener may have disconnected before the last
        // chunk landed, and nobody else would record the completion.
        recordAudioCompletionInBackground(podcastId, episodeId, chunkCount);
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
  chunkCount: number,
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
    chunkCount,
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

  const cachedSizes = await Promise.all(
    chunks.map((_, i) => getCachedChunkSize(podcastId, episodeId, i)),
  );
  const allCached = chunks.length > 0 && cachedSizes.every((s) => s !== null);

  res.set("Content-Type", "audio/aac");
  res.set("Accept-Ranges", "bytes");

  // Path 1: All chunks are cached -> serve seekable static AAC resource.
  //
  // The byte space of this response is this URL's own stream: it starts at
  // `?t=` (frame-aligned) when given, else at the start of the episode. A
  // `Range` header is applied on top of that, never instead of it — a player
  // retrying a `?t=` stream re-requests the same URL with `Range: bytes=N-`
  // where N counts bytes into the response it was already reading, so N must
  // be resolved against the same start `t` gave the original response.
  if (allCached) {
    let startChunkIndex = 0;
    let firstPart: Buffer = Buffer.alloc(0);

    if (seek.startTimeSeconds !== null && seek.startTimeSeconds > 0) {
      let cumulativeSec = 0;
      let seekOffsetInsideChunk = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunkData = await getCachedChunk(podcastId, episodeId, i);
        const dur = chunkData ? getAdtsDurationSeconds(chunkData) : 0;
        if (cumulativeSec + dur > seek.startTimeSeconds) {
          startChunkIndex = i;
          seekOffsetInsideChunk = seek.startTimeSeconds - cumulativeSec;
          break;
        }
        cumulativeSec += dur;
        startChunkIndex = i;
        seekOffsetInsideChunk = Math.max(0, seek.startTimeSeconds - cumulativeSec);
      }
      const startChunkData = await getCachedChunk(podcastId, episodeId, startChunkIndex);
      if (startChunkData) {
        firstPart = sliceAdtsByTime(startChunkData, seekOffsetInsideChunk).buffer;
      }
    } else {
      firstPart = (await getCachedChunk(podcastId, episodeId, 0)) ?? Buffer.alloc(0);
    }

    const laterBytes = cachedSizes
      .slice(startChunkIndex + 1)
      .reduce((sum, s) => sum + (s ?? 0), 0);
    const streamBytes = firstPart.length + laterBytes;

    const skipBytes = seek.rangeStart ?? 0;
    if (seek.rangeStart !== null) {
      if (seek.rangeStart >= streamBytes) {
        res.set("Content-Range", `bytes */${streamBytes}`);
        throw new HttpError(416, "Range Not Satisfiable");
      }
      res.status(206);
      res.set("Content-Range", `bytes ${skipBytes}-${streamBytes - 1}/${streamBytes}`);
    } else {
      res.status(200);
    }
    res.set("Content-Length", String(streamBytes - skipBytes));

    const write = createByteSkipper(skipBytes, (data) => res.write(data));
    write(firstPart);
    for (let i = startChunkIndex + 1; i < chunks.length; i++) {
      const chunkData = await getCachedChunk(podcastId, episodeId, i);
      if (chunkData) write(chunkData);
    }
    res.end();
    void finalizeEpisodeAudio(podcastId, episodeId);
    // Backfills episodes whose audio finished before `audioComplete` existed.
    if (!episode.audioComplete) {
      recordAudioCompletionInBackground(podcastId, episodeId, chunks.length);
    }
    return;
  }

  // Path 2: Live streaming path (chunks still generating)
  // Voices are only needed here — resolved after the all-cached fast path so
  // replaying a fully cached episode never triggers a (slow, billed) voice
  // design just to hand an unused voice id to nothing.
  const voices = await resolveCastVoices(podcastId, episodeId, podcast, episode);

  // NEVER return Content-Length while chunks are still generating (chunked transfer only)
  if (typeof res.removeHeader === "function") {
    res.removeHeader("Content-Length");
  }
  // As in Path 1, `Range: bytes=N-` is N bytes into this URL's own stream
  // (from `?t=` if given), so a player retrying a live stream resumes at the
  // right byte; the skipped bytes are dropped here rather than re-downloaded
  // and discarded by the client. 206 tells the client we honored the Range (a
  // 200 would make it skip N bytes itself). No Content-Range: the total isn't
  // known while chunks are still generating.
  const rangeSkipBytes = seek.rangeStart ?? 0;
  res.status(seek.rangeStart !== null ? 206 : 200);
  const write = createByteSkipper(rangeSkipBytes, (data) => res.write(data));

  // Determine starting chunk if ?t=SECONDS was specified
  let startChunkIndex = 0;
  let cumulativeSec = 0;
  let seekOffsetInsideChunk = 0;
  if (seek.startTimeSeconds !== null && seek.startTimeSeconds > 0) {
    for (let i = 0; i < chunks.length; i++) {
      const size = cachedSizes[i];
      if (size === null) {
        startChunkIndex = i;
        seekOffsetInsideChunk = Math.max(0, seek.startTimeSeconds - cumulativeSec);
        break;
      }
      const data = await getCachedChunk(podcastId, episodeId, i);
      const dur = data ? getAdtsDurationSeconds(data) : 0;
      if (cumulativeSec + dur > seek.startTimeSeconds) {
        startChunkIndex = i;
        seekOffsetInsideChunk = seek.startTimeSeconds - cumulativeSec;
        break;
      }
      cumulativeSec += dur;
      startChunkIndex = i;
      seekOffsetInsideChunk = Math.max(0, seek.startTimeSeconds - cumulativeSec);
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
      if (index === startChunkIndex && seekOffsetInsideChunk > 0) {
        const { buffer: sliced } = sliceAdtsByTime(cached, seekOffsetInsideChunk);
        if (!stopped && sliced.length > 0) write(sliced);
      } else {
        if (!stopped) write(cached);
      }
      runningAudioSeconds += getAdtsDurationSeconds(cached);
      continue;
    }

    // Chunk is NOT cached — live generation
    const chunkTurns = getChunkTurns(episode.transcript, chunk);
    const chunkStartSec = runningAudioSeconds;

    let liveSeekRemaining = index === startChunkIndex ? seekOffsetInsideChunk : 0;

    const { promise, isLeader } = getOrStartChunkGeneration(
      podcastId,
      episodeId,
      index,
      chunkTurns,
      voices,
      chunkStartSec,
      chunks.length,
      (delta) => {
        if (stopped) return;
        if (liveSeekRemaining > 0) {
          const deltaDur = getAdtsDurationSeconds(delta);
          if (deltaDur <= liveSeekRemaining) {
            liveSeekRemaining -= deltaDur;
            return;
          }
          const { buffer: sliced } = sliceAdtsByTime(delta, liveSeekRemaining);
          liveSeekRemaining = 0;
          if (sliced.length > 0) write(sliced);
        } else {
          write(delta);
        }
      },
    );

    try {
      const fullChunk = await promise;
      if (!isLeader && !stopped) {
        if (index === startChunkIndex && seekOffsetInsideChunk > 0) {
          const { buffer: sliced } = sliceAdtsByTime(fullChunk, seekOffsetInsideChunk);
          if (sliced.length > 0) write(sliced);
        } else {
          write(fullChunk);
        }
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
