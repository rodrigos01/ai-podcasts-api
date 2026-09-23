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
  CHUNK_LOCK_POLL_INTERVAL_MS,
  EPISODE_CHUNK_POLL_INTERVAL_MS,
  MAX_CHUNK_AUDIO_SECONDS,
} from "../constants/ttsLimits";
import type { Episode, TtsChunk } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { speakerLabel } from "./episodeGeneration/speakerSelection";
import { findLastSpeakerLabel, parseScriptTurns, SPEAKER_LABEL_RE } from "../utils/scriptText";
import { resolveTimeToByteOffset } from "../utils/oggOpus";
import { OGG_HEADER_PAGES, OggPageAccumulator, OggStitcher } from "../utils/oggStitch";
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
 * it) and rewrites its Ogg pages in place via `stitcher` — dropping every
 * chunk's own OpusHead/OpusTags (the episode's one true header is the fixed
 * OGG_HEADER_PAGES constant, written separately — see streamEpisodeAudio),
 * unifying the serial number, and continuing the page sequence/granule
 * timeline from wherever the episode's previous chunks left off — so what
 * gets cached and relayed is always a fragment of one continuous logical
 * Ogg bitstream, never a standalone chained chunk. See utils/oggStitch.ts.
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
  isLastChunk: boolean,
  onDelta: (delta: Buffer) => void,
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
            const rewritten = stitcher.processPage(rawPage, isLastChunk);
            if (rewritten) {
              parts.push(rewritten);
              onDelta(rewritten);
            }
          }
          // Thrown synchronously from inside streamSpeech's own gRPC "data"
          // handler — it already catches exactly this, destroys the
          // underlying stream, and turns it into a normal rejection (see
          // streamSpeech's own comment on that mechanism). This is the
          // safety net against a chunk that never naturally stops
          // generating (see MAX_CHUNK_AUDIO_SECONDS in ttsLimits.ts) —
          // caught below like any other TTS failure, so it goes through
          // the exact same retry/skip handling.
          if (stitcher.getCurrentChunkSeconds() > MAX_CHUNK_AUDIO_SECONDS) {
            throw new Error(
              `Chunk ${index} exceeded ${MAX_CHUNK_AUDIO_SECONDS}s of synthesized audio — aborting a likely runaway TTS response`,
            );
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
    // only need to catch our own stitcher up, not reprocess anything.
    const cached = await getCachedChunk(podcastId, episodeId, index);
    if (cached) {
      stitcher.deriveFromCachedBuffer(cached);
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
  stitcher: OggStitcher,
  isLastChunk: boolean,
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
    stitcher,
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
 * - While the episode is still in progress (`status: "generating"` while the
 *   script is being written/chunked, `"streamable"` once chunking is done —
 *   at that point `ttsChunks` is already the full, final list, since the
 *   single-LLM script call and its chunking pass both happen in one shot
 *   rather than incrementally; only `condensedSummaries`/`status: "ready"`
 *   are still pending), this stream re-fetches the episode doc and waits
 *   for `status` to reach a terminal value instead of ending the response
 *   the moment it runs out of already-known chunks — so a listener who
 *   started playback the instant the episode became `"streamable"` rides
 *   straight through without a second request. Only a chunk processed once
 *   `status` has already confirmed `"ready"` gets its Ogg `EOS` page
 *   preserved; every chunk processed before that has it cleared, even
 *   though (unlike the old incrementally-sealed pipeline) it may already be
 *   the true final chunk — this is a narrow, cosmetic gap, not a
 *   correctness issue, since stream termination doesn't depend on it.
 *
 * The episode's Ogg header (`OGG_HEADER_PAGES` — see oggStitch.ts) is fixed
 * and independent of any chunk's own content or success, so it's written
 * once, unconditionally, up front — never per-chunk. A real `Range` header
 * is only ever sent by a client resuming a connection it already
 * established from byte 0 earlier (a network retry, or a seek after the
 * player already parsed the stream's format), so it never needs the header
 * re-sent; its byte offset is in full-resource space (header + chunks,
 * what the client actually received), so it's converted to chunk-space
 * (header-exclusive) before slicing the concatenated chunk bytes. `?t=`'s
 * resolved byte offset is already chunk-space (it's derived from
 * `resolveTimeToByteOffset`'s cumulative-audio-duration walk, which never
 * involved the header) and is designed to be the *first* request of a
 * fresh session (e.g. reopening the app to resume a saved position), so
 * the header is written first, unconditionally, before any chunk bytes.
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
    // Cached chunk sizes are audio-only now (no chunk ever carries a
    // header — see oggStitch.ts) — the real resource the client sees is
    // the fixed header plus all of that.
    const chunksTotalLength = initialCachedSizes.reduce((sum, size) => sum + (size ?? 0), 0);
    const fullResourceLength = OGG_HEADER_PAGES.length + chunksTotalLength;

    if (rangeStart >= fullResourceLength) {
      throw new HttpError(416, "Range Not Satisfiable");
    }

    if (isByteRangeRequest && rangeStart > 0) {
      // Real Range request: never re-inject the header (see the function
      // doc comment above) — rangeStart is in full-resource space, so
      // convert to chunk-space before slicing the concatenated chunk bytes.
      const chunkSpaceStart = Math.max(0, rangeStart - OGG_HEADER_PAGES.length);
      res.status(206);
      res.set("Content-Range", `bytes ${rangeStart}-${fullResourceLength - 1}/${fullResourceLength}`);
      res.set("Content-Length", String(fullResourceLength - rangeStart));

      let pos = 0;
      for (let index = 0; index < chunks.length; index++) {
        const data = await getCachedChunk(podcastId, episodeId, index);
        if (data) writeSlice(res, data, pos, chunkSpaceStart);
        pos += data?.length ?? 0;
      }
    } else {
      // Fresh request or `?t=` resume: rangeStart is already chunk-space —
      // write the fixed header first, then the chunk bytes from there.
      res.status(200);
      res.set("Content-Length", String(fullResourceLength - rangeStart));
      if (!res.destroyed && !res.writableEnded) res.write(OGG_HEADER_PAGES);

      let pos = 0;
      for (let index = 0; index < chunks.length; index++) {
        const data = await getCachedChunk(podcastId, episodeId, index);
        if (data) writeSlice(res, data, pos, rangeStart);
        pos += data?.length ?? 0;
      }
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

  // The header is fixed and independent of any chunk (see oggStitch.ts) —
  // written once, unconditionally, before any chunk synthesis even starts.
  // Never for a real Range request, same reasoning as the fully-cached
  // branch above.
  if (!isByteRangeRequest && !res.destroyed && !res.writableEnded) {
    res.write(OGG_HEADER_PAGES);
  }

  let stopped = false;
  res.on("close", () => {
    stopped = true;
  });

  const stitcher = new OggStitcher();
  let pos = 0;
  let index = 0;
  while (!stopped) {
    if (index >= chunks.length) {
      // Caught up to every chunk known as of our last look. If the episode
      // is still "generating" (the script hasn't been written/chunked yet,
      // so `chunks` may currently be empty), poll for it instead of ending
      // the stream early — once it flips to "streamable" or "ready",
      // `ttsChunks` is already the complete, final list (chunking happens
      // in one pass right after the single-LLM script call, not
      // incrementally), so this poll only ever needs to fire while nothing
      // has been chunked yet. "failed" means there's nothing more coming.
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
    // Only trustworthy once `status` has already confirmed "ready" in a
    // prior poll iteration — at that point `chunks` is the complete, final
    // list, so this really is the episode's last chunk, not just the last
    // one sealed so far. See the function doc comment above.
    const isLastChunk = status === "ready" && index === chunks.length - 1;

    if (cachedSize !== null) {
      const data = await getCachedChunk(podcastId, episodeId, index);
      if (data) {
        writeSlice(res, data, chunkStart, bodyStart);
        stitcher.deriveFromCachedBuffer(data);
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
      isLastChunk,
      (delta) => {
        writeSlice(res, delta, chunkStart + emittedInChunk, bodyStart);
        emittedInChunk += delta.length;
      },
    );

    try {
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
        writeSlice(res, fullChunk, chunkStart, bodyStart);
        stitcher.deriveFromCachedBuffer(fullChunk);
        pos = chunkStart + fullChunk.length;
      }
    } catch (err) {
      // Cloud TTS occasionally rejects a chunk outright (most commonly a
      // false-positive content-moderation block on some turn's text, per
      // Gemini TTS's known behavior) — that must not take down the whole
      // stream, or the whole server. Skip the chunk: nothing gets written
      // for it (a small silent gap in the finished audio), and nothing
      // gets cached, so a later request tries generating it fresh — worth
      // it since a moderation false-positive isn't necessarily permanent
      // and a transient failure genuinely might succeed on retry. Every
      // chunk, including chunk 0, is skippable this way now — the
      // episode's header no longer depends on any chunk's own output (see
      // OGG_HEADER_PAGES in oggStitch.ts), so there's no special case left.
      console.error(
        `Skipping podcast ${podcastId} episode ${episodeId} chunk ${index} after TTS failure (nothing written for it):`,
        err,
      );
      if (isLeader) {
        // generateOrJoin's own stitcher.endChunk() was never reached (the
        // failure happened before it) — commit whatever partial granule
        // progress this chunk made, if any, via processPage calls that
        // already ran through onDelta before the failure, so the next
        // chunk's timeline stays consistent with whatever was actually
        // already written to this response.
        stitcher.endChunk();
      }
      // pos is left at chunkStart — this chunk contributed nothing.
    }
    index++;
  }

  if (!res.destroyed && !res.writableEnded) res.end();
}
