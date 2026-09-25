import type { Response } from "express";
import { streamEpisodeSynthesis, type TtsVoiceAssignment } from "../llm/ttsClient";
import {
  createFinalAudioReadStream,
  deleteInProgressAudio,
  getFinalAudioSize,
  getInProgressAudio,
  putInProgressAudio,
} from "../storage/audioCache.repository";
import { releaseAudioGenerationLock, tryAcquireAudioGenerationLock } from "../data/audioLock.repository";
import { bumpGeneratedAudioSeconds, getEpisode } from "../data/episode.repository";
import { AUDIO_POLL_INTERVAL_MS, IN_PROGRESS_FLUSH_INTERVAL_MS } from "../constants/ttsLimits";
import type { Episode } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { speakerLabel } from "./episodeGeneration/speakerSelection";
import { resolveGuestVoice, resolveHostVoice } from "./episodeGeneration/voiceResolution.service";
import { finalizeEpisodeAudio } from "./episodeGeneration/audioFinalize.service";
import { parseScriptTurns } from "../utils/scriptText";
import { buildStreamingWavHeader, buildWav, DEFAULT_PCM_FORMAT, durationSeconds, extractPcm, secondsToByteOffset } from "../utils/wav";
import { HttpError } from "../utils/HttpError";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The gate is "the script exists" — no more `ttsPrompt` (there is no
 * director/producer prompt at all in the new pipeline; see AGENTS.md) and
 * no more per-chunk state to check. A `"streamable"` or `"ready"` episode
 * with a transcript can always have its audio generation started; a
 * `"generating"` episode with no transcript yet has nothing to synthesize.
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
 * Resolves both cast members' TTS voices. The normal path is now a pure
 * Firestore read: orchestrator.ts resolves and persists both cast members'
 * `resolvedVoiceId` at episode-generation time (in parallel with script
 * generation — see AGENTS.md), so by the time a listener's first `/stream`
 * request gets here there's usually nothing left to do. A host still goes
 * through `resolveHostVoice` unconditionally — that's already a cheap
 * cache-hit check (compares `resolvedVoiceHash`) and it's the one place
 * that knows whether a persona/accent/voice-hint edit invalidated the
 * cached design. A guest with no persisted id (a race with a still-running
 * orchestrator, or an episode generated before this architecture existed)
 * falls back to resolving — and persisting — one lazily here, same as the
 * old design. The label returned for each must match, byte-for-byte, what
 * scriptGeneration.prompts.ts told the writer to use for that person
 * (speakerSelection.ts's speakerLabel) — the transcript's turn labels and
 * this mapping have to agree on the same string for a turn to route to the
 * right voice via the API's `speech_metadata` annotation.
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

/** Writes the portion of `data` (starting at absolute PCM offset `dataStart`) that's at or past `bodyStart`. */
function writeSlice(res: Response, data: Buffer, dataStart: number, bodyStart: number): void {
  if (res.destroyed || res.writableEnded) return;
  if (bodyStart < dataStart + data.length) {
    res.write(data.subarray(Math.max(0, bodyStart - dataStart)));
  }
}

/**
 * Serves a fully-generated episode's `final.ogg` as a normal, fully
 * seekable static resource — real `Content-Length`, honors a real `Range`
 * request with `206`/`Content-Range`. No custom offset bookkeeping needed
 * here at all now that it's one complete file instead of N stitched
 * fragments (compare to the old Ogg-chunk-stitching design this replaced).
 */
function serveFinalAudio(podcastId: string, episodeId: string, size: number, res: Response, rangeStart: number | null): void {
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

/**
 * Runs the single streaming synthesis call for an episode's whole
 * transcript (no chunking — see ttsLimits.ts), writing PCM live to `res`
 * (as a growing WAV: header written by the caller before this starts, raw
 * PCM as it arrives here) while periodically flushing a snapshot to
 * Storage so a follower (another listener, or another instance) can tail
 * it instead of starting a redundant, costly second synthesis call.
 *
 * On success, hands the complete PCM off to `finalizeEpisodeAudio` (ffmpeg
 * encode to the one final Ogg Opus file + guest-voice cleanup). On
 * failure — including an unresumable mid-stream stall, per the
 * investigation's confirmed finding — discards the in-progress snapshot
 * entirely rather than trying to splice a retried attempt's (different,
 * non-reproducible) audio onto it; see AGENTS.md's explicitly-accepted
 * tradeoff. Either way the lock is released so a future request can try
 * again.
 */
async function leadGeneration(
  podcastId: string,
  episodeId: string,
  podcast: Podcast,
  episode: Episode & { transcript: string },
  res: Response,
  bodyStart: number,
): Promise<void> {
  const turns = parseScriptTurns(episode.transcript);
  const voices = await resolveCastVoices(podcastId, episodeId, podcast, episode);

  const parts: Buffer[] = [];
  let pos = 0;
  let flushing = false;
  let lastFlushedLength = 0;

  function flushInProgress(): void {
    if (flushing) return;
    const pcm = Buffer.concat(parts);
    if (pcm.length === lastFlushedLength) return;
    flushing = true;
    lastFlushedLength = pcm.length;
    Promise.all([
      putInProgressAudio(podcastId, episodeId, buildWav(DEFAULT_PCM_FORMAT, pcm)),
      bumpGeneratedAudioSeconds(podcastId, episodeId, durationSeconds(DEFAULT_PCM_FORMAT, pcm.length)),
    ])
      .catch((err) => console.error(`Failed to flush in-progress audio for ${podcastId}/${episodeId}:`, err))
      .finally(() => {
        flushing = false;
      });
  }

  let lastFlushAt = Date.now();

  try {
    await streamEpisodeSynthesis(turns, voices, (pcm) => {
      writeSlice(res, pcm, pos, bodyStart);
      pos += pcm.length;
      parts.push(pcm);
      if (Date.now() - lastFlushAt > IN_PROGRESS_FLUSH_INTERVAL_MS) {
        lastFlushAt = Date.now();
        flushInProgress();
      }
    });
  } catch (err) {
    await deleteInProgressAudio(podcastId, episodeId).catch(() => {});
    throw err;
  }

  const fullPcm = Buffer.concat(parts);
  await putInProgressAudio(podcastId, episodeId, buildWav(DEFAULT_PCM_FORMAT, fullPcm));
  await bumpGeneratedAudioSeconds(podcastId, episodeId, durationSeconds(DEFAULT_PCM_FORMAT, fullPcm.length));
  await finalizeEpisodeAudio(podcastId, episodeId, fullPcm);
}

/**
 * Tails another instance's (or another listener's) in-flight generation by
 * polling the in-progress WAV snapshot. Simplification, stated plainly: a
 * follower serves this one HTTP connection as a self-contained WAV response
 * from whatever ends up in the snapshot by the time the lock is released,
 * whether that's a complete episode (the common case) or a leader that
 * crashed partway (rare) — it does not attempt to take over and continue
 * generating mid-response. `final.ogg` is checked too, since it's possible
 * (though unlikely, given polling cadence) for generation to finish between
 * two polls.
 */
async function followGeneration(podcastId: string, episodeId: string, res: Response, bodyStart: number): Promise<void> {
  let pos = 0;
  for (;;) {
    if (res.destroyed || res.writableEnded) return;

    const finalSize = await getFinalAudioSize(podcastId, episodeId);
    const wav = await getInProgressAudio(podcastId, episodeId);
    if (wav) {
      const { pcm } = extractPcm(wav);
      if (pcm.length > pos) {
        const newBytes = pcm.subarray(pos);
        writeSlice(res, newBytes, pos, bodyStart);
        pos = pcm.length;
      }
    }

    if (finalSize !== null) return; // leader finished; our WAV response is already complete or as complete as it'll get
    const stillGenerating = await tryAcquireAudioGenerationLock(podcastId, episodeId);
    if (stillGenerating) {
      // The lock was actually free — no one is generating. Either the
      // leader finished (and we've already read its final snapshot above)
      // or it crashed before writing anything. Release immediately; we're
      // not becoming a leader mid-response (see this function's doc
      // comment) — just end here with whatever we have.
      await releaseAudioGenerationLock(podcastId, episodeId);
      return;
    }
    await sleep(AUDIO_POLL_INTERVAL_MS);
  }
}

/**
 * Streams an episode's audio. specs.md's Audio Delivery section calls for
 * on-demand, listen-triggered generation, with scrubbing disallowed until
 * every chunk exists — with chunking gone, that's now "until the whole
 * episode is synthesized":
 *
 * - `final.ogg` already exists: serve it as a normal static, fully
 *   seekable resource (see serveFinalAudio).
 * - Otherwise: become the generation leader (single streaming
 *   `interactions.create` call for the whole transcript — see
 *   ttsClient.ts) or a follower tailing the leader's in-progress snapshot.
 *   A real `Range` header can't be honored precisely here (no known total
 *   length yet) — same as the old per-chunk design's documented
 *   limitation — so it's ignored in favor of a plain `200` from byte 0;
 *   `?t=` resumes via `secondsToByteOffset` (exact now, for the whole
 *   episode, since WAV has a fixed bytes-per-second relationship — no more
 *   chunk-boundary approximation).
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

  const isByteRangeRequest = seek.rangeStart !== null;
  const bodyStart = isByteRangeRequest
    ? 0
    : seek.startTimeSeconds !== null
      ? secondsToByteOffset(DEFAULT_PCM_FORMAT, seek.startTimeSeconds)
      : 0;

  res.set("Content-Type", "audio/wav");
  res.status(200);
  // The header is written once, unconditionally, before any PCM — except
  // for a real Range request, which only ever resumes a connection that
  // already parsed the format from an earlier request on the same logical
  // stream (a player's own seek, or a network retry), same reasoning as
  // the old design's OGG_HEADER_PAGES handling.
  if (!isByteRangeRequest && !res.destroyed) {
    res.write(buildStreamingWavHeader(DEFAULT_PCM_FORMAT));
  }

  const acquired = await tryAcquireAudioGenerationLock(podcastId, episodeId);
  try {
    if (acquired) {
      await leadGeneration(podcastId, episodeId, podcast, episode, res, bodyStart);
    } else {
      await followGeneration(podcastId, episodeId, res, bodyStart);
    }
  } catch (err) {
    console.error(`Episode ${podcastId}/${episodeId} audio generation failed:`, err);
  } finally {
    if (acquired) await releaseAudioGenerationLock(podcastId, episodeId);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}
