import type { Response } from "express";
import { streamEpisodeSynthesis, type TtsVoiceAssignment } from "../llm/ttsClient";
import {
  getCachedChunk,
  getCachedChunkSize,
  putCachedChunk,
} from "../storage/audioCache.repository";
import { releaseChunkLock, tryAcquireChunkLock } from "../data/audioLock.repository";
import { bumpGeneratedAudioSeconds, getAudioEpoch, getEpisode, markAudioComplete } from "../data/episode.repository";
import { AUDIO_POLL_INTERVAL_MS, CHUNK_LOCK_POLL_INTERVAL_MS } from "../constants/ttsLimits";
import type { Episode, TtsChunk } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { speakerLabel } from "./episodeGeneration/speakerSelection";
import { hasCurrentVoice, resolveGuestVoice, resolveHostVoice } from "./episodeGeneration/voiceResolution.service";
import { finalizeEpisodeAudio } from "./episodeGeneration/audioFinalize.service";
import { ensureGenerationRunning } from "./episodeGeneration/orchestrator";
import { chunkTranscript, getChunkTurns } from "./episodeGeneration/chunker";
import type { ScriptTurn } from "../utils/scriptText";
import { DEFAULT_PCM_FORMAT, durationSeconds } from "../utils/wav";
import { createAacStreamEncoder, encodePcmToAac, getAdtsDurationSeconds, sliceAdtsByTime } from "../utils/aac";
import { HttpError } from "../utils/HttpError";
import { AudioCancelledError, isAudioCancelled, trackGeneration } from "../utils/audioCancellation";
import { createByteSkipper } from "../utils/rangeSkip";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks that the episode is in a state where audio can be streamed.
 * Generation failure or missing transcript blocks playback. A
 * `"generating"` episode with a transcript but no sealed `ttsChunks` yet
 * is also blocked — see orchestrator.ts's progressive-sealing design: that
 * narrow pre-gate window (both cast members haven't spoken yet) means
 * whatever transcript tail exists might still be mid-turn, so it isn't
 * safe to chunk on the fly the way the fallback below does for an episode
 * that's already streamable/ready.
 */
function assertAudioAvailable(episode: Episode): asserts episode is Episode & { transcript: string } {
  if (episode.status === "failed") {
    throw HttpError.badRequest("Episode generation failed");
  }
  if (!episode.transcript) {
    throw HttpError.badRequest("Episode audio is not ready yet");
  }
  if (episode.status === "generating" && (!episode.ttsChunks || episode.ttsChunks.length === 0)) {
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
  startEpoch: number,
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
  // Guarded by the epoch: if the audio was cleared while the chunks were being read, the files
  // are (being) deleted and the episode must not be marked complete.
  await markAudioComplete(podcastId, episodeId, totalSeconds, startEpoch);
}

/** In-flight completion checks on this process instance, so concurrent callers share one. */
const completionInFlight = new Map<string, Promise<void>>();

/**
 * Records completion if every chunk is cached, sharing a single in-flight check per episode
 * (the generating instance and the /stream request that ends the response both ask). Never
 * rejects: a failure to record is logged, not fatal to playback.
 */
function recordAudioCompletion(
  podcastId: string,
  episodeId: string,
  chunkCount: number,
  startEpoch: number,
): Promise<void> {
  // Per epoch: a check begun before a clear must not be reused by one begun after it.
  const key = `${podcastId}:${episodeId}:${startEpoch}`;
  const existing = completionInFlight.get(key);
  if (existing) return existing;

  const promise = recordAudioCompletionIfDone(podcastId, episodeId, chunkCount, startEpoch)
    .catch((err) => {
      console.error(`Failed to record audio completion for ${podcastId}/${episodeId}:`, err);
    })
    .finally(() => completionInFlight.delete(key));
  completionInFlight.set(key, promise);
  return promise;
}

/** How often a running generation checks whether the episode's audio was cleared on another instance. */
const EPOCH_POLL_INTERVAL_MS = 1_500;

/**
 * Throws [AudioCancelledError] if the episode's audio was cleared since the request that is
 * generating started (its `audioEpoch` changed) — see utils/audioCancellation.ts.
 */
async function assertNotCleared(podcastId: string, episodeId: string, startEpoch: number): Promise<void> {
  if ((await getAudioEpoch(podcastId, episodeId)) !== startEpoch) throw new AudioCancelledError();
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
  startEpoch: number,
  onDelta: (delta: Buffer) => void,
): Promise<Buffer> {
  for (;;) {
    // A listener whose audio was cleared must not start (or wait for) a fresh generation.
    await assertNotCleared(podcastId, episodeId, startEpoch);
    const acquired = await tryAcquireChunkLock(podcastId, episodeId, index);
    if (acquired) {
      const encoder = createAacStreamEncoder(onDelta);
      // Stoppable from this process (abort) and from other instances (the epoch poll).
      const controller = new AbortController();
      const untrack = trackGeneration(podcastId, episodeId, controller);
      const epochWatcher = setInterval(() => {
        assertNotCleared(podcastId, episodeId, startEpoch).catch((err) => {
          if (isAudioCancelled(err)) controller.abort(err);
        });
      }, EPOCH_POLL_INTERVAL_MS);
      try {
        let totalPcmBytes = 0;
        await streamEpisodeSynthesis(
          chunkTurns,
          voices,
          (pcmDelta) => {
            totalPcmBytes += pcmDelta.length;
            encoder.write(pcmDelta);
          },
          undefined,
          controller.signal,
        );
        const fullAac = await encoder.end();
        // Last look before caching: a clear that landed meanwhile has already (or is about to)
        // delete the audio, and this chunk would come back as stale audio.
        if (controller.signal.aborted) throw new AudioCancelledError();
        await assertNotCleared(podcastId, episodeId, startEpoch);
        await putCachedChunk(podcastId, episodeId, index, fullAac);
        const chunkSec = durationSeconds(DEFAULT_PCM_FORMAT, totalPcmBytes);
        await bumpGeneratedAudioSeconds(
          podcastId,
          episodeId,
          chunkStartSeconds + chunkSec,
          startEpoch,
        );
        // Done here, by the generating instance, as well as before a /stream
        // response ends: the listener may have disconnected before the last
        // chunk landed, and nobody else would record the completion. Not
        // awaited, so the listener hears the chunk's audio without waiting on it.
        void recordAudioCompletion(podcastId, episodeId, chunkCount, startEpoch);
        return fullAac;
      } catch (err) {
        encoder.destroy(err instanceof Error ? err : undefined);
        throw controller.signal.aborted ? new AudioCancelledError() : err;
      } finally {
        clearInterval(epochWatcher);
        untrack();
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
  startEpoch: number,
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
    startEpoch,
    onDelta,
  );

  inFlightGenerations.set(key, promise);
  // The derived promise would reject too (a cancelled generation does) with nobody to handle it.
  promise.finally(() => inFlightGenerations.delete(key)).catch(() => undefined);
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

  // Audio cleared after this point cancels this request's generation (see utils/audioCancellation.ts).
  const startEpoch = episode.audioEpoch ?? 0;

  // Reassigned below (in the live path) whenever a still-in-progress
  // episode's currently-known chunks run out and a fresh copy is fetched —
  // see the "ran out of known chunks" branch of the main loop.
  let currentEpisode: Episode = episode;
  let chunks: TtsChunk[] =
    episode.ttsChunks && episode.ttsChunks.length > 0
      ? episode.ttsChunks
      : chunkTranscript(episode.transcript);

  const cachedSizes = await Promise.all(
    chunks.map((_, i) => getCachedChunkSize(podcastId, episodeId, i)),
  );
  // Only a "ready" episode's ttsChunks is guaranteed to be the complete,
  // final list — while "generating"/"streamable", more chunks may still be
  // coming even if every chunk sealed *so far* happens to already be
  // cached, so that case must still take the live path below instead of
  // being served as a truncated, Content-Length-bounded static resource.
  const allCached =
    episode.status === "ready" && chunks.length > 0 && cachedSizes.every((s) => s !== null);

  res.set("Content-Type", "audio/aac");
  res.set("Accept-Ranges", "bytes");

  // Path 1: episode is "ready" (the only state guaranteeing ttsChunks is the
  // complete, final list) and every chunk is cached -> serve seekable static
  // AAC resource.
  //
  // The byte space of this response is this URL's own stream: it starts at
  // `?t=` (frame-aligned) when given, else at the start of the episode. A
  // `Range` header is applied on top of that, never instead of it — a player
  // retrying a `?t=` stream re-requests the same URL with `Range: bytes=N-`
  // where N counts bytes into the response it was already reading, so N must
  // be resolved against the same start `t` gave the original response.
  if (allCached) {
    // Flag completion before any bytes go out, so a client that sees this
    // stream end can already tell it's a genuine end. Only episodes whose audio
    // finished before the flag existed (or whose generating instance died
    // before recording it) pay for this, once.
    if (!episode.audioComplete) {
      await recordAudioCompletion(podcastId, episodeId, chunks.length, startEpoch);
    }

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

  // A `for` loop over a fixed `chunks.length` would end the response the
  // moment it catches up to whatever was known when this request started —
  // wrong for a still-generating episode, where more chunks may land in
  // Firestore while this request is in flight. Once `index` runs out of
  // currently-known chunks, re-fetch the episode and keep going instead of
  // stopping, as long as it isn't done yet (by the orchestrator's
  // continuation-based recovery design, an episode that's ever sealed a
  // chunk can only reach "ready" from here, never "failed" — see AGENTS.md).
  let index = startChunkIndex;
  while (!stopped) {
    if (index >= chunks.length) {
      if (currentEpisode.status === "ready" || currentEpisode.status === "failed") break;
      await sleep(AUDIO_POLL_INTERVAL_MS);
      const fresh = await getEpisode(podcastId, episodeId);
      if (!fresh) break;
      currentEpisode = fresh;
      // The generation this listener is waiting on may have died (its
      // instance recycled): resume it rather than wait on it forever.
      void ensureGenerationRunning(podcastId, fresh);
      chunks =
        currentEpisode.ttsChunks && currentEpisode.ttsChunks.length > 0
          ? currentEpisode.ttsChunks
          : chunkTranscript(currentEpisode.transcript ?? episode.transcript);
      continue;
    }

    const chunk = chunks[index];
    if (!chunk) {
      index++;
      continue;
    }

    const cached = await getCachedChunk(podcastId, episodeId, index);
    if (cached) {
      if (index === startChunkIndex && seekOffsetInsideChunk > 0) {
        const { buffer: sliced } = sliceAdtsByTime(cached, seekOffsetInsideChunk);
        if (!stopped && sliced.length > 0) write(sliced);
      } else {
        if (!stopped) write(cached);
      }
      runningAudioSeconds += getAdtsDurationSeconds(cached);
      index++;
      continue;
    }

    // Chunk is NOT cached — live generation
    const chunkTurns = getChunkTurns(currentEpisode.transcript ?? episode.transcript, chunk);
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
      startEpoch,
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
      if (isAudioCancelled(err)) {
        if ((await getAudioEpoch(podcastId, episodeId)) === startEpoch) {
          // Cancelled for another request's sake (we had joined its generation): go again.
          index -= 1;
          continue;
        }
        // The audio was cleared under this listener: drop the connection so the player retries
        // and picks up the freshly generated audio instead of a truncated stream.
        res.destroy();
        return;
      }
      console.error(`Chunk ${index} generation failed for ${podcastId}/${episodeId}:`, err);
      throw err;
    }
    index++;
  }

  // If that was the last chunk, flag completion *before* ending the response, so
  // a client that sees this stream end can already tell it's the real end and
  // not a close at the live generation edge. Skipped if the client already left.
  const finalCachedSizes = await Promise.all(
    chunks.map((_, i) => getCachedChunkSize(podcastId, episodeId, i)),
  );
  const nowComplete = chunks.length > 0 && finalCachedSizes.every((s) => s !== null);
  if (nowComplete && !stopped) {
    await recordAudioCompletion(podcastId, episodeId, chunks.length, startEpoch);
  }

  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }

  // Trigger voice cleanup if all chunks are now ready
  if (nowComplete) {
    void finalizeEpisodeAudio(podcastId, episodeId);
  }
}
