import type { Response } from "express";
import { streamSpeech } from "../llm/geminiClient";
import {
  getCachedChunk,
  getCachedChunkSize,
  putCachedChunk,
} from "../storage/audioCache.repository";
import { releaseChunkLock, tryAcquireChunkLock } from "../data/audioLock.repository";
import { bumpGeneratedAudioSeconds, getEpisode } from "../data/episode.repository";
import { CHUNK_LOCK_POLL_INTERVAL_MS, EPISODE_CHUNK_POLL_INTERVAL_MS } from "../constants/ttsLimits";
import type { Episode, TtsChunk } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { findLastSpeakerLabel, parseScriptTurns, SPEAKER_LABEL_RE } from "../utils/scriptText";
import { resolveTimeToByteOffset } from "../utils/oggOpus";
import { extractHeaderPages, OggPageAccumulator, OggStitcher } from "../utils/oggStitch";
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

/**
 * Generates one chunk (or joins another instance's in-flight generation of
 * it) and rewrites its Ogg pages in place via `stitcher` — dropping
 * duplicate headers, unifying the serial number, and continuing the page
 * sequence/granule timeline from wherever the episode's previous chunks
 * left off — so what gets cached and relayed is always a fragment of one
 * continuous logical Ogg bitstream, never a standalone chained chunk. See
 * utils/oggStitch.ts.
 *
 * `onDelta`'s second argument marks a piece that's part of the episode's
 * only OpusHead/OpusTags (always chunk 0) — callers must relay these
 * unconditionally, even into a response that otherwise starts later.
 *
 * Whichever path this takes (real generation below, or the cross-instance
 * cache-poll fallback), `stitcher`'s state is guaranteed correct by the
 * time this returns, so a caller processing chunks strictly in order can
 * always trust it for the next chunk.
 *
 * Only the real-generation path persists `Episode.generatedAudioSeconds`
 * (via bumpGeneratedAudioSeconds) — the cache-poll fallback relays a chunk
 * some other instance already generated and accounted for, and callers
 * relaying an already-cached chunk from streamEpisodeAudio's main loop
 * never call this function at all for it.
 */
async function generateOrJoin(
  podcastId: string,
  episodeId: string,
  index: number,
  directorPrompt: string,
  chunkText: string,
  speakers: { speaker: string; voiceName: string }[],
  stitcher: OggStitcher,
  isFirstChunk: boolean,
  isLastChunk: boolean,
  onDelta: (delta: Buffer, isHeader: boolean) => void,
): Promise<Buffer> {
  for (;;) {
    const acquired = await tryAcquireChunkLock(podcastId, episodeId, index);
    if (acquired) {
      try {
        stitcher.startChunk();
        const accumulator = new OggPageAccumulator();
        const parts: Buffer[] = [];
        await streamSpeech(directorPrompt, parseScriptTurns(chunkText), speakers, (delta) => {
          for (const rawPage of accumulator.push(delta)) {
            const rewritten = stitcher.processPage(rawPage, isFirstChunk, isLastChunk);
            if (rewritten) {
              parts.push(rewritten.page);
              onDelta(rewritten.page, rewritten.isHeader);
            }
          }
        });
        accumulator.assertDrained();
        stitcher.endChunk();
        const full = Buffer.concat(parts);
        await putCachedChunk(podcastId, episodeId, index, full);
        await bumpGeneratedAudioSeconds(podcastId, episodeId, stitcher.getCumulativeSeconds());
        return full;
      } finally {
        await releaseChunkLock(podcastId, episodeId, index);
      }
    }

    // Another instance holds the lock and is generating this chunk right
    // now — wait for it to land in the cache instead of duplicating the
    // (costly) TTS call ourselves. If that instance dies mid-generation,
    // its lock goes stale and a future iteration of tryAcquireChunkLock
    // above will steal it and generate here instead. The cached bytes are
    // already fully rewritten by whichever instance produced them, so we
    // only need to catch our own stitcher up, not reprocess anything — but
    // we do need to split out chunk 0's header so the caller can relay it
    // unconditionally like it would for a live-generated page.
    const cached = await getCachedChunk(podcastId, episodeId, index);
    if (cached) {
      stitcher.deriveFromCachedBuffer(cached, isFirstChunk);
      if (isFirstChunk) {
        const header = extractHeaderPages(cached);
        onDelta(header, true);
        onDelta(cached.subarray(header.length), false);
      } else {
        onDelta(cached, false);
      }
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
  stitcher: OggStitcher,
  isFirstChunk: boolean,
  isLastChunk: boolean,
  onDelta: (delta: Buffer, isHeader: boolean) => void,
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
    stitcher,
    isFirstChunk,
    isLastChunk,
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
 * Writes an already-fully-rewritten whole chunk buffer, same as writeSlice,
 * except when `mayNeedHeader` — chunk 0, and only when the caller has
 * decided this response may legitimately start beyond it (a `?t=` resume,
 * never a real Range header — see streamEpisodeAudio). In that case, its
 * OpusHead/OpusTags pages are written unconditionally first, since they're
 * the *only* copy anywhere in the episode: every later chunk's own copy was
 * already dropped by the stitcher.
 */
function writeChunk(
  res: Response,
  data: Buffer,
  chunkStart: number,
  start: number,
  mayNeedHeader: boolean,
): void {
  if (mayNeedHeader && start > chunkStart) {
    const header = extractHeaderPages(data);
    const headerEnd = chunkStart + header.length;
    if (start < headerEnd) {
      if (!res.destroyed && !res.writableEnded) res.write(header);
      writeSlice(res, data, chunkStart, headerEnd);
      return;
    }
  }
  writeSlice(res, data, chunkStart, start);
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
 * - While the episode is still in progress (`status: "generating"` before
 *   any chunk is sealed, `"streamable"` once at least one is), chunk
 *   boundaries keep being sealed by the orchestrator as the conversation
 *   progresses (see chunker.ts's sealedChunksSoFar). Once this stream has
 *   generated audio for every chunk sealed so far, it re-fetches the
 *   episode doc and waits for more to appear instead of ending the
 *   response — so a listener who started playback early rides straight
 *   through into newly-generated audio without a second request. Since a
 *   chunk generated while the episode isn't yet `"ready"` can never be
 *   trusted as the episode's true final chunk (sealing always holds back
 *   the still-growing tail until generation completes), only a chunk
 *   processed once `status` has already confirmed `"ready"` — meaning
 *   `chunks` is now the complete, final list — gets its Ogg `EOS` page
 *   preserved; every other chunk has it cleared, even if it's the last one
 *   sealed *so far*.
 *
 * A real `Range` header is only ever sent by a client resuming a
 * connection it already established from byte 0 earlier (a network retry,
 * or a seek after the player already parsed the stream's format) — so it
 * never needs the episode's header re-sent, and we never inject it there,
 * in either branch, to avoid miscounting bytes relative to what that
 * client already has. `?t=`'s resolved byte offset is different: it's
 * designed to be the *first* request of a fresh session (e.g. reopening
 * the app to resume a saved position), so if it lands past chunk 0 — the
 * only chunk carrying the stream's OpusHead/OpusTags, since the stitcher
 * drops every later chunk's copy — the header is injected unconditionally
 * first. Without this, a client cold-starting via `?t=` into a later chunk
 * would receive a stream with no header at all and could never identify
 * its format.
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

  const isByteRangeRequest = seek.rangeStart !== null;
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

    // Never inject the header for a real Range request — see the function
    // doc comment above for why that would miscount bytes for a client
    // resuming a connection it already parsed the format from.
    const mayNeedHeader = !isByteRangeRequest;
    const chunk0 = mayNeedHeader && rangeStart > 0 ? await getCachedChunk(podcastId, episodeId, 0) : null;
    const injectedHeaderLength = chunk0 ? extractHeaderPages(chunk0).length : 0;
    const effectiveStart = Math.max(rangeStart, injectedHeaderLength);

    if (isByteRangeRequest && rangeStart > 0) {
      res.status(206);
      res.set("Content-Range", `bytes ${rangeStart}-${totalLength - 1}/${totalLength}`);
      res.set("Content-Length", String(totalLength - rangeStart));
    } else {
      res.status(200);
      res.set("Content-Length", String(injectedHeaderLength + (totalLength - effectiveStart)));
    }

    let pos = 0;
    for (let index = 0; index < chunks.length; index++) {
      const data = index === 0 && chunk0 ? chunk0 : await getCachedChunk(podcastId, episodeId, index);
      if (data) writeChunk(res, data, pos, rangeStart, index === 0 && mayNeedHeader);
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

  const stitcher = new OggStitcher();
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
    const isFirstChunk = index === 0;
    // Only trustworthy once `status` has already confirmed "ready" in a
    // prior poll iteration — at that point `chunks` is the complete, final
    // list, so this really is the episode's last chunk, not just the last
    // one sealed so far. See the function doc comment above.
    const isLastChunk = status === "ready" && index === chunks.length - 1;

    if (cachedSize !== null) {
      const data = await getCachedChunk(podcastId, episodeId, index);
      if (data) {
        writeChunk(res, data, chunkStart, bodyStart, isFirstChunk);
        stitcher.deriveFromCachedBuffer(data, isFirstChunk);
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
      stitcher,
      isFirstChunk,
      isLastChunk,
      (delta, isHeader) => {
        if (isHeader) {
          if (!res.destroyed && !res.writableEnded) res.write(delta);
        } else {
          writeSlice(res, delta, chunkStart + emittedInChunk, bodyStart);
        }
        emittedInChunk += delta.length;
      },
    );

    if (isLeader) {
      // Progressive delivery already happened via the onDelta callback
      // above, and generateOrJoin already brought `stitcher` up to date.
      const fullChunk = await promise;
      pos = chunkStart + fullChunk.length;
    } else {
      // Follower: no progressive delivery occurred for us, and our own
      // `stitcher` instance never saw this chunk's pages — catch it up
      // from the (already rewritten) shared result before relaying it.
      const fullChunk = await promise;
      writeChunk(res, fullChunk, chunkStart, bodyStart, isFirstChunk);
      stitcher.deriveFromCachedBuffer(fullChunk, isFirstChunk);
      pos = chunkStart + fullChunk.length;
    }
    index++;
  }

  if (!res.destroyed && !res.writableEnded) res.end();
}
