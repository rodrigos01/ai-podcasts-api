import type { Response } from "express";
import { streamSpeech } from "../llm/geminiClient";
import {
  getCachedChunk,
  getCachedChunkSize,
  putCachedChunk,
} from "../storage/audioCache.repository";
import { releaseChunkLock, tryAcquireChunkLock } from "../data/audioLock.repository";
import { getEpisode } from "../data/episode.repository";
import { CHUNK_LOCK_POLL_INTERVAL_MS, EPISODE_CHUNK_POLL_INTERVAL_MS } from "../constants/ttsLimits";
import type { Episode, TtsChunk } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { findLastSpeakerLabel, parseScriptTurns, SPEAKER_LABEL_RE } from "../utils/scriptText";
import { resolveTimeToByteOffset } from "../utils/oggOpus";
import { HttpError } from "../utils/HttpError";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chunk offsets are pure slices of the transcript (see chunker.ts) — a
 * chunk that's a continuation of an oversized single turn won't itself
 * start with a "Name:" label, so we look backward for the nearest one.
 */
function getChunkText(transcript: string, chunk: TtsChunk): string {
  const raw = transcript.slice(chunk.startOffset, chunk.endOffset);
  if (SPEAKER_LABEL_RE.test(raw)) return raw;

  const label = findLastSpeakerLabel(transcript.slice(0, chunk.startOffset));
  return label ? `${label} ${raw}` : raw;
}

function resolveCastVoices(
  podcast: Podcast,
  episode: Episode,
): { speaker: string; voiceName: string }[] {
  const hosts = podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id));
  return [...hosts, ...episode.guests].map((p) => ({ speaker: p.name, voiceName: p.voice }));
}

/**
 * The producer prompt (see producerPrompt.service.ts) is generated from
 * persona/podcast/episode metadata before the conversation starts, and chunk
 * boundaries are sealed incrementally as the conversation progresses (see
 * chunker.ts's sealedChunksSoFar, wired up in orchestrator.ts) — so audio
 * can start streaming as soon as the first chunk is sealed, well before the
 * episode reaches status "ready". This only rules out the cases where there
 * is nothing to stream at all: generation hasn't produced a prompt yet, or
 * it failed outright.
 */
function assertAudioAvailable(episode: Episode): asserts episode is Episode & { ttsPrompt: string } {
  if (episode.status === "failed") {
    throw HttpError.badRequest("Episode generation failed");
  }
  if (!episode.ttsPrompt) {
    throw HttpError.badRequest("Episode audio is not ready yet");
  }
}

/**
 * Concurrent requests hitting the same not-yet-cached chunk (a retried
 * connection, a double-tap on play) must not each independently call the
 * TTS API for it. Only the first ("leader") request actually generates —
 * it drives the shared promise below and gets true low-latency progressive
 * delivery via its onDelta callback. Any concurrent ("follower") request
 * for the same chunk just awaits the same promise and writes the resulting
 * buffer once it resolves, same as a cache hit.
 *
 * This Map only dedupes requests landing on *this* process — on Cloud Run,
 * multiple instances each have their own empty Map, so it's not sufficient
 * on its own. generateOrJoin below adds a Firestore-backed lock
 * (audioLock.repository.ts) so at most one instance actually calls the TTS
 * API for a given chunk; any other instance's "leader" (first *local*
 * caller) ends up waiting for the real leader elsewhere and relaying the
 * cached result once it lands, rather than generating a duplicate.
 */
const inFlightGenerations = new Map<string, Promise<Buffer>>();

function chunkKey(podcastId: string, episodeId: string, index: number): string {
  return `${podcastId}:${episodeId}:${index}`;
}

async function generateOrJoin(
  podcastId: string,
  episodeId: string,
  index: number,
  directorPrompt: string,
  chunkText: string,
  speakers: { speaker: string; voiceName: string }[],
  onDelta: (delta: Buffer) => void,
): Promise<Buffer> {
  for (;;) {
    const acquired = await tryAcquireChunkLock(podcastId, episodeId, index);
    if (acquired) {
      try {
        const parts: Buffer[] = [];
        await streamSpeech(directorPrompt, parseScriptTurns(chunkText), speakers, (delta) => {
          parts.push(delta);
          onDelta(delta);
        });
        const full = Buffer.concat(parts);
        await putCachedChunk(podcastId, episodeId, index, full);
        return full;
      } finally {
        await releaseChunkLock(podcastId, episodeId, index);
      }
    }

    // Another instance holds the lock and is generating this chunk right
    // now — wait for it to land in the cache instead of duplicating the
    // (costly) TTS call ourselves. If that instance dies mid-generation,
    // its lock goes stale and a future iteration of tryAcquireChunkLock
    // above will steal it and generate here instead.
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
  directorPrompt: string,
  chunkText: string,
  speakers: { speaker: string; voiceName: string }[],
  onDelta: (delta: Buffer) => void,
): { promise: Promise<Buffer>; isLeader: boolean } {
  const key = chunkKey(podcastId, episodeId, index);
  const existing = inFlightGenerations.get(key);
  if (existing) {
    return { promise: existing, isLeader: false };
  }

  const promise = generateOrJoin(
    podcastId,
    episodeId,
    index,
    directorPrompt,
    chunkText,
    speakers,
    onDelta,
  );

  inFlightGenerations.set(key, promise);
  promise.finally(() => inFlightGenerations.delete(key));
  return { promise, isLeader: true };
}

/** Writes `data` sliced from `rangeStart` (relative to `chunkStart`), if any of it is in range. */
function writeSlice(res: Response, data: Buffer, chunkStart: number, rangeStart: number): void {
  if (res.destroyed || res.writableEnded) return;
  if (rangeStart < chunkStart + data.length) {
    res.write(data.subarray(Math.max(0, rangeStart - chunkStart)));
  }
}

/**
 * Streams the concatenation of an episode's TTS chunks as one continuous
 * Ogg Opus resource, generating (and caching) any chunk on demand the first
 * time it's needed. specs.md's Audio Delivery section calls for on-demand,
 * listen-triggered generation streamed back to the client, with scrubbing
 * disallowed until every chunk exists — so:
 *
 * - If the episode has finished generating (`status: "ready"`) and every
 *   chunk is already cached, we know the total length: serve a normal,
 *   fully seekable static resource (real Content-Length, Accept-Ranges,
 *   honors any Range request).
 * - Otherwise we serve chunked-transfer (no Content-Length) starting from
 *   `rangeStart`, live-generating and caching whatever chunk(s) that offset
 *   falls into or beyond. A `Range` request into the *already-cached*
 *   prefix resumes precisely from there; one that reaches into ungenerated
 *   territory just continues generation from that chunk's start until
 *   enough bytes exist to satisfy it.
 * - While the episode is still in progress (`status: "generating"` before
 *   any chunk is sealed, `"streamable"` once at least one is), chunk
 *   boundaries keep being sealed by the orchestrator as the conversation
 *   progresses (see chunker.ts's sealedChunksSoFar). Once this stream has
 *   generated audio for every chunk sealed so far, it re-fetches the
 *   episode doc and waits for more to appear instead of ending the
 *   response — so a listener who started playback early rides straight
 *   through into newly-generated audio without a second request.
 *
 * `seek.rangeStart` (an exact byte offset, from a `Range` header) takes
 * priority; `seek.startTimeSeconds` (a saved playback position in seconds)
 * is resolved to the nearest chunk boundary at-or-before that time — see
 * utils/oggOpus.ts for why byte-exact time resume isn't possible anymore
 * now that chunks are compressed instead of raw PCM. Both are resolved
 * against whatever chunks are sealed at request time; seeking ahead of
 * that isn't supported, same as seeking ahead of ungenerated audio never
 * has been.
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
  const speakers = resolveCastVoices(podcast, episode);

  let chunks = episode.ttsChunks ?? [];
  let transcript = episode.transcript ?? "";
  let status = episode.status;
  const ttsPrompt = episode.ttsPrompt;

  const initialCachedSizes = await Promise.all(
    chunks.map((_, index) => getCachedChunkSize(podcastId, episodeId, index)),
  );

  const rangeStart =
    seek.rangeStart ??
    (seek.startTimeSeconds !== null
      ? await resolveTimeToByteOffset(
          seek.startTimeSeconds,
          chunks.length,
          (index) => initialCachedSizes[index] ?? null,
          (index) => getCachedChunk(podcastId, episodeId, index),
        )
      : 0);

  res.set("Content-Type", "audio/ogg");
  res.set("Accept-Ranges", "bytes");

  // Fully generated AND fully cached: total length is known, so we can
  // serve a normal seekable static resource. While the episode is still
  // generating, more chunks may still be sealed after this snapshot, so we
  // always fall through to the live/incremental path below instead.
  if (status === "ready" && initialCachedSizes.every((size) => size !== null)) {
    const totalLength = initialCachedSizes.reduce((sum, size) => sum + (size ?? 0), 0);

    if (rangeStart >= totalLength) {
      throw new HttpError(416, "Range Not Satisfiable");
    }

    if (rangeStart > 0) {
      res.status(206);
      res.set("Content-Range", `bytes ${rangeStart}-${totalLength - 1}/${totalLength}`);
    } else {
      res.status(200);
    }
    res.set("Content-Length", String(totalLength - rangeStart));

    let pos = 0;
    for (let index = 0; index < chunks.length; index++) {
      const data = await getCachedChunk(podcastId, episodeId, index);
      if (data) writeSlice(res, data, pos, rangeStart);
      pos += data?.length ?? 0;
    }
    res.end();
    return;
  }

  res.status(200);

  let stopped = false;
  res.on("close", () => {
    stopped = true;
  });

  let pos = 0;
  let index = 0;
  while (!stopped) {
    if (index >= chunks.length) {
      // Caught up to every chunk sealed as of our last look. If the episode
      // is still in progress ("generating" — nothing sealed yet — or
      // "streamable" — some chunks sealed, more turns still to come), more
      // chunk boundaries may land in Firestore as the conversation
      // continues — poll for them instead of ending the stream early.
      // "ready" here means we've genuinely reached the end (possibly the
      // episode finished while we were mid-stream); "failed" means there's
      // nothing more coming.
      if (status === "ready" || status === "failed") break;
      await sleep(EPISODE_CHUNK_POLL_INTERVAL_MS);
      const fresh = await getEpisode(podcastId, episodeId);
      if (!fresh) break;
      status = fresh.status;
      chunks = fresh.ttsChunks ?? chunks;
      transcript = fresh.transcript ?? transcript;
      continue;
    }

    const chunk = chunks[index];
    if (!chunk) {
      index++;
      continue;
    }
    const chunkStart = pos;
    const cachedSize = await getCachedChunkSize(podcastId, episodeId, index);

    if (cachedSize !== null) {
      const data = await getCachedChunk(podcastId, episodeId, index);
      if (data) writeSlice(res, data, chunkStart, rangeStart);
      pos = chunkStart + (data?.length ?? 0);
      index++;
      continue;
    }

    const chunkText = getChunkText(transcript, chunk);

    let emittedInChunk = 0;
    const { promise, isLeader } = getOrStartChunkGeneration(
      podcastId,
      episodeId,
      index,
      ttsPrompt,
      chunkText,
      speakers,
      (delta) => {
        writeSlice(res, delta, chunkStart + emittedInChunk, rangeStart);
        emittedInChunk += delta.length;
      },
    );

    if (isLeader) {
      // Progressive delivery already happened via the onDelta callback above.
      const fullChunk = await promise;
      pos = chunkStart + fullChunk.length;
    } else {
      // Follower: no progressive delivery occurred for us — write once, in full, when ready.
      const fullChunk = await promise;
      writeSlice(res, fullChunk, chunkStart, rangeStart);
      pos = chunkStart + fullChunk.length;
    }
    index++;
  }

  if (!res.destroyed && !res.writableEnded) res.end();
}
