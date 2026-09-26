import type { Response } from "express";
import { streamSpeech } from "../llm/geminiClient";
import {
  getCachedChunk,
  getCachedChunkSize,
  putCachedChunk,
} from "../storage/audioCache.repository";
import { releaseChunkLock, tryAcquireChunkLock } from "../data/audioLock.repository";
import { bumpGeneratedAudioSeconds, getEpisode } from "../data/episode.repository";
import {
  AAC_BITRATE_KBPS,
  CHUNK_LOCK_POLL_INTERVAL_MS,
  EPISODE_CHUNK_POLL_INTERVAL_MS,
  MAX_CHUNK_AUDIO_SECONDS,
  TTS_SAMPLE_RATE_HERTZ,
} from "../constants/ttsLimits";
import type { Episode, TtsChunk } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { speakerLabel } from "./episodeGeneration/speakerSelection";
import { findLastSpeakerLabel, parseScriptTurns, SPEAKER_LABEL_RE } from "../utils/scriptText";
import { getAdtsDurationSeconds, resolveTimeToByteOffset } from "../utils/adts";
import { PcmToAacEncoder } from "../utils/aacEncoder";
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

/**
 * The `speaker` field returned here must match, byte-for-byte, the label
 * scriptGeneration.prompts.ts told the writer to use for that person (first
 * name only, unless the cast shares a first name — see speakerSelection.ts's
 * speakerLabel) — the transcript's turn labels, this mapping, and
 * geminiClient.ts's `aliasByName` all have to agree on the same string for
 * a chunk's speaker to route to the right voice.
 */
function resolveCastVoices(
  podcast: Podcast,
  episode: Episode,
): { speaker: string; voiceName: string }[] {
  const hosts = podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id));
  const [p1, p2] = [...hosts, ...episode.guests];
  if (!p1 || !p2) return [];
  return [
    { speaker: speakerLabel(p1.name, p2.name), voiceName: p1.voice },
    { speaker: speakerLabel(p2.name, p1.name), voiceName: p2.voice },
  ];
}

/**
 * The producer prompt (see producerPrompt.service.ts) is generated from
 * persona/podcast/episode metadata alone, in parallel with the single-LLM
 * script-writing call (see scriptGeneration.service.ts) — neither needs the
 * other. All TTS chunks are known as soon as that script call returns and
 * gets chunked (orchestrator.ts), at which point status flips straight to
 * "streamable", well before the episode reaches "ready" (condensation may
 * still be running). This only rules out the cases where there is nothing
 * to stream at all: generation hasn't produced a prompt yet, or it failed
 * outright.
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

/**
 * Generates one chunk (or joins another instance's in-flight generation of
 * it), encoding Cloud TTS's raw PCM output to ADTS AAC on the fly via a
 * fresh per-chunk `PcmToAacEncoder` (see utils/aacEncoder.ts) — no
 * cross-chunk rewriting is needed the way Ogg Opus chunks used to need (see
 * AGENTS.md): every encoded frame is self-delimited, so caching the
 * encoder's own output verbatim is enough for chunks to concatenate into
 * one playable resource later.
 *
 * `cumulativeSecondsBefore` is the episode's total audio duration already
 * accounted for by every earlier chunk (cached or freshly generated) in
 * this same request, tracked by the caller (streamEpisodeAudio) — needed
 * here only to report the correct running total to
 * `bumpGeneratedAudioSeconds`, since each chunk's own cached bytes carry no
 * absolute/cross-chunk position (unlike Ogg's granule scheme).
 *
 * Only the real-generation path calls bumpGeneratedAudioSeconds — the
 * cross-instance cache-poll fallback relays a chunk some other instance
 * already generated and accounted for, and a caller relaying an
 * already-cached chunk from streamEpisodeAudio's main loop never calls this
 * function at all for it.
 */
async function generateOrJoin(
  podcastId: string,
  episodeId: string,
  index: number,
  directorPrompt: string,
  chunkText: string,
  speakers: { speaker: string; voiceName: string }[],
  cumulativeSecondsBefore: number,
  onDelta: (delta: Buffer) => void,
): Promise<Buffer> {
  for (;;) {
    const acquired = await tryAcquireChunkLock(podcastId, episodeId, index);
    if (acquired) {
      const encoder = new PcmToAacEncoder(TTS_SAMPLE_RATE_HERTZ, AAC_BITRATE_KBPS, onDelta);
      try {
        let pcmBytesThisChunk = 0;
        await streamSpeech(directorPrompt, parseScriptTurns(chunkText), speakers, (delta) => {
          pcmBytesThisChunk += delta.length;
          // 16-bit mono PCM: 2 bytes/sample. Computed directly from the raw
          // PCM byte count as it arrives — unlike the old Ogg granule-based
          // check, this doesn't need to wait for the (lookahead-delayed)
          // encoder output to know how much audio Cloud TTS has actually
          // produced so far, so a runaway response is still caught as soon
          // as it happens.
          const chunkSeconds = pcmBytesThisChunk / (2 * TTS_SAMPLE_RATE_HERTZ);
          if (chunkSeconds > MAX_CHUNK_AUDIO_SECONDS) {
            throw new Error(
              `Chunk ${index} exceeded ${MAX_CHUNK_AUDIO_SECONDS}s of requested audio — aborting a likely runaway TTS response`,
            );
          }
          // Thrown synchronously from inside streamSpeech's own gRPC "data"
          // handler — it already catches exactly this, destroys the
          // underlying stream, and turns it into a normal rejection (see
          // streamSpeech's own comment on that mechanism).
          encoder.write(delta);
        });
        const full = await encoder.finish();
        const durationSeconds = getAdtsDurationSeconds(full, TTS_SAMPLE_RATE_HERTZ);
        await putCachedChunk(podcastId, episodeId, index, full);
        await bumpGeneratedAudioSeconds(podcastId, episodeId, cumulativeSecondsBefore + durationSeconds);
        return full;
      } catch (err) {
        // Abandoning this chunk (streamSpeech rejected, or our own
        // MAX_CHUNK_AUDIO_SECONDS guard fired) — the encoder's ffmpeg
        // process is still alive waiting on stdin unless we kill it here,
        // which would otherwise leak as an orphaned process.
        encoder.kill();
        throw err;
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
  cumulativeSecondsBefore: number,
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
    cumulativeSecondsBefore,
    onDelta,
  );

  inFlightGenerations.set(key, promise);
  promise.finally(() => inFlightGenerations.delete(key));
  return { promise, isLeader: true };
}

/** Writes `data` sliced from `start` (relative to `chunkStart`), if any of it is in range. */
function writeSlice(res: Response, data: Buffer, chunkStart: number, start: number): void {
  if (res.destroyed || res.writableEnded) return;
  if (start < chunkStart + data.length) {
    res.write(data.subarray(Math.max(0, start - chunkStart)));
  }
}

/**
 * Streams the concatenation of an episode's TTS chunks as one continuous
 * ADTS AAC resource, generating (and caching) any chunk on demand the first
 * time it's needed. specs.md's Audio Delivery section calls for on-demand,
 * listen-triggered generation streamed back to the client, with scrubbing
 * disallowed until every chunk exists — so:
 *
 * - If the episode has finished (`status: "ready"`) and every chunk is
 *   already cached, we know the total length: serve a normal, fully
 *   seekable static resource (real Content-Length, Accept-Ranges, honors
 *   any Range request).
 * - Otherwise we don't know the final length, so we serve chunked-transfer
 *   (no Content-Length) starting from `rangeStart`, live-generating and
 *   caching whatever chunk(s) that offset falls into or beyond. A `Range`
 *   request into the *already-cached* prefix resumes precisely from there;
 *   one that reaches into ungenerated territory just continues generation
 *   from that chunk's start until enough bytes exist to satisfy it. A real
 *   `Range` header can't be honored with a valid `206`/`Content-Range` in
 *   this branch — that requires a concrete end position, which an
 *   unfinished resource doesn't have — so a byte-Range resume request gets
 *   the full body from byte 0 with a plain `200`, exactly what an HTTP
 *   client expects when its Range request wasn't honored, and it
 *   self-skips accordingly.
 * - While the episode is still in progress (`status: "generating"` while
 *   the script is being written/chunked, `"streamable"` once chunking is
 *   done — at that point `ttsChunks` is already the full, final list),
 *   this stream re-fetches the episode doc and waits for `status` to reach
 *   a terminal value instead of ending the response the moment it runs out
 *   of already-known chunks — so a listener who started playback the
 *   instant the episode became `"streamable"` rides straight through
 *   without a second request.
 *
 * Unlike the old Ogg Opus delivery, there is no shared episode-wide header
 * to write — ADTS AAC frames are self-delimited with no shared "logical
 * stream" concept (see utils/adts.ts), so every byte offset here is already
 * in the same space as what a client receives, with no header-length
 * adjustment anywhere (contrast the pre-2026-09-26 version of this file,
 * which had to convert between "full resource space" and "chunk space").
 *
 * `seek.rangeStart` (an exact byte offset, from a `Range` header) takes
 * priority; `seek.startTimeSeconds` (a saved playback position in seconds)
 * is resolved to the nearest ADTS frame boundary at-or-before that time —
 * see utils/adts.ts's resolveTimeToByteOffset for the sub-chunk-precision
 * frame walk this enables now that chunks no longer need to be chained.
 * Both are resolved against whatever chunks are sealed at request time;
 * seeking ahead of that isn't supported, same as seeking ahead of
 * ungenerated audio never has been.
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

  const isByteRangeRequest = seek.rangeStart !== null;
  const rangeStart =
    seek.rangeStart ??
    (seek.startTimeSeconds !== null
      ? await resolveTimeToByteOffset(
          seek.startTimeSeconds,
          TTS_SAMPLE_RATE_HERTZ,
          chunks.length,
          (index) => initialCachedSizes[index] ?? null,
          (index) => getCachedChunk(podcastId, episodeId, index),
        )
      : 0);

  res.set("Content-Type", "audio/aac");
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

    res.status(isByteRangeRequest ? 206 : 200);
    if (isByteRangeRequest) {
      res.set("Content-Range", `bytes ${rangeStart}-${totalLength - 1}/${totalLength}`);
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

  // Total length is still unknown, so a real Range request can't be
  // honored precisely (no valid Content-Range without a concrete end) —
  // only skip the body forward when the skip came from `?t=`, not an
  // actual Range header (this also means `bodyStart > 0` below can only
  // happen for a `?t=` resume, never a real Range request).
  const bodyStart = isByteRangeRequest ? 0 : rangeStart;
  res.status(200);

  let stopped = false;
  res.on("close", () => {
    stopped = true;
  });

  let pos = 0;
  let index = 0;
  let cumulativeSeconds = 0;
  while (!stopped) {
    if (index >= chunks.length) {
      // Caught up to every chunk known as of our last look. If the episode
      // is still "generating" (the script hasn't been written/chunked yet,
      // so `chunks` may currently be empty), poll for it instead of ending
      // the stream early — once it flips to "streamable" or "ready",
      // `ttsChunks` is already the complete, final list. "failed" means
      // there's nothing more coming.
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
      if (data) {
        writeSlice(res, data, chunkStart, bodyStart);
        cumulativeSeconds += getAdtsDurationSeconds(data, TTS_SAMPLE_RATE_HERTZ);
      }
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
      cumulativeSeconds,
      (delta) => {
        writeSlice(res, delta, chunkStart + emittedInChunk, bodyStart);
        emittedInChunk += delta.length;
      },
    );

    try {
      const fullChunk = await promise;
      if (!isLeader) {
        // Follower: no progressive delivery occurred for us (that already
        // happened, if at all, via the leader's own onDelta) — write the
        // whole resolved buffer ourselves.
        writeSlice(res, fullChunk, chunkStart, bodyStart);
      }
      cumulativeSeconds += getAdtsDurationSeconds(fullChunk, TTS_SAMPLE_RATE_HERTZ);
      pos = chunkStart + fullChunk.length;
    } catch (err) {
      // Cloud TTS occasionally rejects a chunk outright (most commonly a
      // false-positive content-moderation block on some turn's text, per
      // Gemini TTS's known behavior) — that must not take down the whole
      // stream, or the whole server. Skip the chunk: nothing gets written
      // for it (a small silent gap in the finished audio), and nothing
      // gets cached, so a later request tries generating it fresh. Unlike
      // the old Ogg Opus pipeline, there's no cross-chunk state to keep
      // consistent afterward — a skipped chunk simply contributes zero
      // bytes and zero duration, nothing else to reconcile.
      console.error(
        `Skipping podcast ${podcastId} episode ${episodeId} chunk ${index} after TTS failure (nothing written for it):`,
        err,
      );
      // pos and cumulativeSeconds are left unchanged — this chunk contributed nothing.
    }
    index++;
  }

  if (!res.destroyed && !res.writableEnded) res.end();
}
