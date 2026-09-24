import { storageBucket } from "../config/firebase";

// Gemini 3.8 Flash TTS migration: an episode's audio is now one continuous
// streamed synthesis job (no chunking — see ttsLimits.ts), so there are
// only ever two objects per episode instead of N per-chunk fragments:
//
// - in-progress.wav: a growing WAV snapshot of whatever's been synthesized
//   so far, flushed periodically while a generation leader's streaming call
//   is still running (see audio.service.ts). Temporary — meant to expire on
//   its own (7-day TTL, see scripts/configure-audio-storage-lifecycle.ts;
//   not yet applied to the production bucket).
// - final.ogg: the one finished, fully seekable Ogg Opus file, written once
//   by audioFinalize.service.ts after the whole episode's audio has been
//   generated (ffmpeg-encoded from the complete WAV — the new model has no
//   compressed output of its own). Meant to live longer (90-day TTL, same
//   script).
//
// Both are stamped with GCS `customTime` metadata at write time — the
// mechanism the lifecycle script's `daysSinceCustomTime` rules key off, so
// each object's TTL clock starts from when it was actually written, not
// just its GCS creation time (relevant for in-progress.wav, which is
// overwritten repeatedly during one generation).

function inProgressAudioPath(podcastId: string, episodeId: string): string {
  return `podcasts/${podcastId}/episodes/${episodeId}/audio/in-progress.wav`;
}

function finalAudioPath(podcastId: string, episodeId: string): string {
  return `podcasts/${podcastId}/episodes/${episodeId}/audio/final.ogg`;
}

export async function getInProgressAudio(podcastId: string, episodeId: string): Promise<Buffer | null> {
  const file = storageBucket.file(inProgressAudioPath(podcastId, episodeId));
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return contents;
}

export async function putInProgressAudio(podcastId: string, episodeId: string, wav: Buffer): Promise<void> {
  const file = storageBucket.file(inProgressAudioPath(podcastId, episodeId));
  await file.save(wav, { contentType: "audio/wav", metadata: { customTime: new Date().toISOString() } });
}

export async function deleteInProgressAudio(podcastId: string, episodeId: string): Promise<void> {
  const file = storageBucket.file(inProgressAudioPath(podcastId, episodeId));
  await file.delete({ ignoreNotFound: true });
}

export async function getFinalAudio(podcastId: string, episodeId: string): Promise<Buffer | null> {
  const file = storageBucket.file(finalAudioPath(podcastId, episodeId));
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return contents;
}

/** Cheap size check (no download) — used to compute Content-Length for a finished episode's static resource. */
export async function getFinalAudioSize(podcastId: string, episodeId: string): Promise<number | null> {
  const file = storageBucket.file(finalAudioPath(podcastId, episodeId));
  try {
    const [metadata] = await file.getMetadata();
    return metadata.size ? Number(metadata.size) : 0;
  } catch {
    return null;
  }
}

/** A `{ start, end }`-bounded read of the final Ogg file, for real byte-Range requests. */
export function createFinalAudioReadStream(
  podcastId: string,
  episodeId: string,
  range?: { start: number; end?: number },
): NodeJS.ReadableStream {
  const file = storageBucket.file(finalAudioPath(podcastId, episodeId));
  return file.createReadStream(range);
}

export async function putFinalAudio(podcastId: string, episodeId: string, ogg: Buffer): Promise<void> {
  const file = storageBucket.file(finalAudioPath(podcastId, episodeId));
  await file.save(ogg, { contentType: "audio/ogg", metadata: { customTime: new Date().toISOString() } });
}

export async function deleteEpisodeAudio(podcastId: string, episodeId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/episodes/${episodeId}/audio/`;
  await storageBucket.deleteFiles({ prefix });
}

export async function deletePodcastAudio(podcastId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/`;
  await storageBucket.deleteFiles({ prefix });
}
