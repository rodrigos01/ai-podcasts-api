import type { Response } from "express";
import { streamSpeech } from "../llm/geminiClient";
import {
  getCachedChunk,
  getCachedChunkSize,
  getCachedCompleteWebm,
  putCachedChunk,
  putCachedCompleteWebm,
} from "../storage/audioCache.repository";
import { releaseChunkLock, tryAcquireChunkLock } from "../data/audioLock.repository";
import { CHUNK_LOCK_POLL_INTERVAL_MS } from "../constants/ttsLimits";
import type { Episode, TtsChunk } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { findLastSpeakerLabel, parseScriptTurns, SPEAKER_LABEL_RE } from "../utils/scriptText";
import { resolveTimeToChunkIndex } from "../utils/oggOpus";
import { createOggToWebmRemuxer, remuxOggBufferToWebmFile } from "../utils/webmRemux";
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

function assertAudioReady(episode: Episode): asserts episode is Episode & {
  ttsChunks: TtsChunk[];
  transcript: string;
  ttsPrompt: string;
} {
  if (episode.status !== "ready" || !episode.ttsChunks || !episode.transcript || !episode.ttsPrompt) {
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

/**
 * Remuxes cached Ogg Opus chunks [startIndex, endIndexExclusive) into one
 * WebM file — every chunk in the range must already be cached. Used both to
 * build an episode's canonical `complete.webm` artifact (the full range) and
 * to serve a `?t=` time-resume once an episode is fully cached (a suffix
 * range, remuxed fresh as its own standalone, from-the-start WebM stream).
 */
async function remuxChunkRange(
  podcastId: string,
  episodeId: string,
  startIndex: number,
  endIndexExclusive: number,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (let index = startIndex; index < endIndexExclusive; index++) {
    const data = await getCachedChunk(podcastId, episodeId, index);
    if (!data) throw new Error(`Missing cached chunk ${index} while remuxing chunk range`);
    parts.push(data);
  }
  return remuxOggBufferToWebmFile(Buffer.concat(parts));
}

/**
 * Returns the episode's canonical WebM artifact, building and persisting it
 * on first use. This is the file a later request (or, eventually, a CDN in
 * front of the bucket) serves directly — see audioCache.repository.ts.
 */
async function ensureCompleteWebm(
  podcastId: string,
  episodeId: string,
  chunkCount: number,
): Promise<Buffer> {
  const cached = await getCachedCompleteWebm(podcastId, episodeId);
  if (cached) return cached;
  const webm = await remuxChunkRange(podcastId, episodeId, 0, chunkCount);
  await putCachedCompleteWebm(podcastId, episodeId, webm);
  return webm;
}

/** Writes a 200/206 response for a single, fully-known WebM buffer, honoring an exact byte offset. */
function sendWebmBuffer(res: Response, data: Buffer, rangeStart: number): void {
  if (rangeStart > 0 && rangeStart >= data.length) {
    throw new HttpError(416, "Range Not Satisfiable");
  }
  if (rangeStart > 0) {
    res.status(206);
    res.set("Content-Range", `bytes ${rangeStart}-${data.length - 1}/${data.length}`);
  } else {
    res.status(200);
  }
  res.set("Content-Length", String(data.length - rangeStart));
  res.end(data.subarray(rangeStart));
}

/**
 * Serves a fully-cached episode. A `Range` header (exact byte offset) is
 * served straight from the finished `complete.webm` buffer — this is why
 * that artifact is remuxed with a real Cues/SeekHead index (see
 * webmRemux.ts): standard byte-range slicing over it is enough for players
 * to seek precisely on their own. A `?t=` resume (no `Range` header) instead
 * remuxes just the requested chunk-boundary-onward suffix into its own
 * fresh, from-the-start WebM stream, matching the same chunk-boundary
 * precision `?t=` has always had.
 */
async function serveCachedEpisode(
  podcastId: string,
  episodeId: string,
  chunkCount: number,
  seek: { rangeStart: number | null; startTimeSeconds: number | null },
  res: Response,
): Promise<void> {
  if (seek.rangeStart !== null) {
    const webm = await ensureCompleteWebm(podcastId, episodeId, chunkCount);
    sendWebmBuffer(res, webm, seek.rangeStart);
    return;
  }

  if (seek.startTimeSeconds !== null) {
    const startIndex = await resolveTimeToChunkIndex(
      seek.startTimeSeconds,
      chunkCount,
      () => true,
      (index) => getCachedChunk(podcastId, episodeId, index),
    );
    if (startIndex > 0) {
      const webm = await remuxChunkRange(podcastId, episodeId, startIndex, chunkCount);
      sendWebmBuffer(res, webm, 0);
      return;
    }
  }

  const webm = await ensureCompleteWebm(podcastId, episodeId, chunkCount);
  sendWebmBuffer(res, webm, 0);
}

/**
 * Relays a still-generating episode's audio live: feeds each chunk's Ogg
 * Opus bytes (cached or freshly generated) into one ffmpeg remux process
 * for the whole request, relaying its WebM output to the response as it's
 * produced — generating (and caching) any not-yet-cached chunk on demand,
 * same as before this remux step was introduced. specs.md's Audio Delivery
 * section calls for on-demand, listen-triggered generation streamed back to
 * the client, with scrubbing disallowed until every chunk exists.
 *
 * A byte-exact `Range` resume isn't reproducible here without re-running the
 * whole remux from scratch and discarding leading output — not worth the
 * complexity for what's normally a short window before an episode finishes
 * generating, so it's intentionally not supported while still-generating: a
 * `Range` header is ignored and this always serves a full 200 response
 * (spec-compliant — a server that won't honor a Range request serves the
 * whole resource instead). `startIndex` (from `?t=`, resolved to the nearest
 * chunk boundary by the caller) still restarts a fresh stream from there.
 */
async function relayLiveAudio(
  podcastId: string,
  episodeId: string,
  episode: Episode & { ttsChunks: TtsChunk[]; transcript: string; ttsPrompt: string },
  speakers: { speaker: string; voiceName: string }[],
  cachedSizes: (number | null)[],
  startIndex: number,
  res: Response,
): Promise<void> {
  const chunks = episode.ttsChunks;
  const remuxer = createOggToWebmRemuxer();

  let stopped = false;
  res.on("close", () => {
    stopped = true;
    remuxer.destroy();
  });
  remuxer.stdout.on("data", (data: Buffer) => {
    if (!res.destroyed && !res.writableEnded) res.write(data);
  });

  const feedDone = (async () => {
    for (let index = startIndex; index < chunks.length && !stopped; index++) {
      const chunk = chunks[index];
      if (!chunk) continue;

      if (cachedSizes[index] !== null) {
        const data = await getCachedChunk(podcastId, episodeId, index);
        if (data) remuxer.write(data);
        continue;
      }

      const chunkText = getChunkText(episode.transcript, chunk);
      const { promise, isLeader } = getOrStartChunkGeneration(
        podcastId,
        episodeId,
        index,
        episode.ttsPrompt,
        chunkText,
        speakers,
        (delta) => remuxer.write(delta),
      );

      const fullChunk = await promise;
      // Leader: progressive delivery already happened via the onDelta callback above.
      // Follower: no progressive delivery occurred for us — write once, in full, when ready.
      if (!isLeader) remuxer.write(fullChunk);
    }
    remuxer.end();
  })();

  try {
    await feedDone;
    await remuxer.done;
  } catch (err) {
    if (!stopped) throw err;
  } finally {
    if (!res.destroyed && !res.writableEnded) res.end();
  }

  if (!stopped && startIndex === 0) {
    // Every chunk now exists — best-effort finalize the CDN-ready artifact
    // for future requests. Failures here must never affect this response,
    // which has already completed successfully.
    ensureCompleteWebm(podcastId, episodeId, chunks.length).catch((err) => {
      console.error(`Failed to finalize complete.webm for ${podcastId}/${episodeId}:`, err);
    });
  }
}

/**
 * Streams an episode's audio as WebM/Opus, generating (and caching) any
 * not-yet-generated chunk on demand. Cloud TTS only gives us Ogg Opus (see
 * geminiClient.ts), which compresses well but plays back unreliably on
 * Android, especially progressively over HTTP — so every response here is
 * remuxed from the cached Ogg Opus chunks into WebM (container change only,
 * `-c:a copy`, no re-encode — see utils/webmRemux.ts) before being sent.
 *
 * - If every chunk is already cached: serveCachedEpisode serves the
 *   episode's finished `complete.webm` artifact (or a `?t=`-resumed suffix
 *   of it) as a normal, fully seekable static resource.
 * - Otherwise: relayLiveAudio serves `Transfer-Encoding: chunked` (no
 *   Content-Length, since the final size isn't known yet), live-remuxing
 *   each chunk's Ogg Opus bytes to WebM as they're generated.
 */
export async function streamEpisodeAudio(
  podcastId: string,
  episodeId: string,
  episode: Episode,
  podcast: Podcast,
  res: Response,
  seek: { rangeStart: number | null; startTimeSeconds: number | null },
): Promise<void> {
  assertAudioReady(episode);
  const chunks = episode.ttsChunks;
  const speakers = resolveCastVoices(podcast, episode);

  const cachedSizes = await Promise.all(
    chunks.map((_, index) => getCachedChunkSize(podcastId, episodeId, index)),
  );
  const allCached = cachedSizes.every((size) => size !== null);

  res.set("Content-Type", "audio/webm; codecs=opus");
  res.set("Accept-Ranges", "bytes");

  if (allCached) {
    await serveCachedEpisode(podcastId, episodeId, chunks.length, seek, res);
    return;
  }

  const startIndex =
    seek.startTimeSeconds !== null
      ? await resolveTimeToChunkIndex(
          seek.startTimeSeconds,
          chunks.length,
          (index) => cachedSizes[index] !== null,
          (index) => getCachedChunk(podcastId, episodeId, index),
        )
      : 0;

  res.status(200);
  await relayLiveAudio(podcastId, episodeId, episode, speakers, cachedSizes, startIndex, res);
}
