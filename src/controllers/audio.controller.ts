import type { Request, Response } from "express";
import { getEpisode } from "../data/episode.repository";
import { requireUserId } from "../middleware/requireAuth";
import { requireOwnedPodcast } from "../services/podcastAccess";
import { streamEpisodeAudio } from "../services/audio.service";
import { ensureGenerationRunning } from "../services/episodeGeneration/orchestrator";
import { clearEpisodeAudio } from "../services/audioClear.service";
import { HttpError } from "../utils/HttpError";
import { requireParam } from "../utils/params";
import { env } from "../config/env";
import { signedEpisodeAudioUrl, verifyAudioToken } from "../utils/audioUrl";
import { publicOrigin } from "../utils/voicePreview";
import { getPodcast } from "../data/podcast.repository";
import type { Episode } from "../schemas/episode.schema";
import type { Podcast } from "../schemas/podcast.schema";

async function loadContext(podcastId: string, episodeId: string, userId: string) {
  const podcast = await requireOwnedPodcast(podcastId, userId);
  const episode = await getEpisode(podcastId, episodeId);
  if (!episode) throw HttpError.notFound("Episode not found");
  return { podcast, episode };
}

// We only support an open-ended "bytes=START-" range (what players use to
// resume playback) — a bounded "bytes=START-END" window is parsed for its
// start only; we still stream through to the end of the episode regardless.
function parseRangeStart(rangeHeader: string | undefined): number | null {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d+)-/);
  return match?.[1] ? Number(match[1]) : null;
}

// `t` (seconds) lets a client resume from a saved playback position without
// needing to know this app's PCM format to compute a byte offset itself —
// e.g. "the user left off at 12:34, they're back, start the stream there."
// A `Range` header, if present, takes precedence (that's what a player's
// own native seek — <audio>.currentTime — actually issues).
function parseStartTime(query: Request["query"]): number | null {
  const raw = query.t;
  if (typeof raw !== "string") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function serveAudio(req: Request, res: Response, podcast: Podcast, episode: Episode) {
  const podcastId = podcast.id;
  const episodeId = episode.id;

  // A listener on an episode whose generation stalled brings it back.
  void ensureGenerationRunning(podcastId, episode);

  const rangeStart = parseRangeStart(req.headers.range);
  const startTime = parseStartTime(req.query);

  // Diagnostics for dropped/cut-short streams: a client that sees the response
  // end early (proxy/Cloud Run timeout, network drop) can't tell us why, so log
  // how each stream began and how it ended.
  const startedAt = Date.now();
  let bytesSent = 0;
  const originalWrite = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (Buffer.isBuffer(chunk)) bytesSent += chunk.length;
    return originalWrite(chunk, ...rest);
  }) as typeof res.write;
  console.log(
    `audio stream start ${podcastId}/${episodeId} range=${req.headers.range ?? "-"} t=${startTime ?? "-"}`,
  );
  res.on("close", () => {
    console.log(
      `audio stream close ${podcastId}/${episodeId} status=${res.statusCode} ` +
        `completed=${res.writableFinished} bytes=${bytesSent} elapsedMs=${Date.now() - startedAt}`,
    );
  });

  await streamEpisodeAudio(podcastId, episodeId, episode, podcast, res, {
    rangeStart,
    startTimeSeconds: startTime,
  });
}

export async function stream(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const episodeId = requireParam(req.params, "episodeId");
  const { podcast, episode } = await loadContext(podcastId, episodeId, requireUserId(req));
  await serveAudio(req, res, podcast, episode);
}

/**
 * Authenticated: hands the caller a signed, expiring URL to play (and to send
 * to a cast device). Returns `{ url, expiresAt }` (unix seconds).
 */
export async function url(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const episodeId = requireParam(req.params, "episodeId");
  await loadContext(podcastId, episodeId, requireUserId(req));
  res.json(signedEpisodeAudioUrl(publicOrigin(req), podcastId, episodeId, env.AUDIO_URL_SECRET));
}

/**
 * `GET /stream/:token`, for players that can't send credentials (a cast
 * receiver fetches this itself): the token from `url` above carries the
 * podcast and episode ids, so it needs no Firebase token. Same stream as
 * `/audio/stream`.
 */
export async function publicAudio(req: Request, res: Response) {
  const ids = verifyAudioToken(env.AUDIO_URL_SECRET, req.params.token);
  if (!ids) throw new HttpError(403, "Invalid or expired audio URL");
  const podcast = await getPodcast(ids.podcastId);
  const episode = podcast ? await getEpisode(ids.podcastId, ids.episodeId) : null;
  if (!podcast || !episode) throw HttpError.notFound("Episode not found");
  await serveAudio(req, res, podcast, episode);
}

export async function clear(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const episodeId = requireParam(req.params, "episodeId");
  const { episode } = await loadContext(podcastId, episodeId, requireUserId(req));

  await clearEpisodeAudio(podcastId, episodeId, episode);
  res.status(204).send();
}
