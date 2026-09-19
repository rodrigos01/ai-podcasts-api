import { storageBucket } from "../config/firebase";

// Each chunk is a fully self-contained Ogg Opus stream (own header, own
// final page) from one streamingSynthesize call — independently valid and
// playable on its own. Concatenating several forms a "chained" Ogg
// bitstream — spec-legal, but confirmed empirically that ExoPlayer's
// OggExtractor doesn't follow a chain past its first logical stream, so
// nothing serves these chunks concatenated raw to a client anymore (see
// utils/oggRemux.ts, which collapses them into one logical stream first).
// See utils/oggOpus.ts for how per-chunk duration is recovered from this
// per-chunk structure for time-based resume.
function chunkPath(podcastId: string, episodeId: string, chunkIndex: number): string {
  return `podcasts/${podcastId}/episodes/${episodeId}/audio/chunk-${chunkIndex}.opus`;
}

// The client-facing artifact: every chunk above remuxed (container-only, no
// re-encode — see utils/oggRemux.ts) into one finished, non-chained Ogg
// stream, built once a fully-cached episode's audio.service.ts caller
// finalizes it. This is what /stream serves directly for a completed
// episode, and what a CDN in front of this bucket would eventually point
// at — the per-chunk cache above stays purely an internal generation-time
// detail (each chunk is itself a separate logical Ogg stream, so naively
// concatenating them — what /stream used to serve directly — produces a
// "chained" bitstream that ExoPlayer's OggExtractor doesn't follow past the
// first chunk; the remux collapses that into one logical stream instead).
function completeOggPath(podcastId: string, episodeId: string): string {
  return `podcasts/${podcastId}/episodes/${episodeId}/audio/complete.ogg`;
}

export async function getCachedChunk(
  podcastId: string,
  episodeId: string,
  chunkIndex: number,
): Promise<Buffer | null> {
  const file = storageBucket.file(chunkPath(podcastId, episodeId, chunkIndex));
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return contents;
}

/** Cheap size check (no download) — used to compute byte offsets across chunks for Range requests. */
export async function getCachedChunkSize(
  podcastId: string,
  episodeId: string,
  chunkIndex: number,
): Promise<number | null> {
  const file = storageBucket.file(chunkPath(podcastId, episodeId, chunkIndex));
  try {
    const [metadata] = await file.getMetadata();
    return metadata.size ? Number(metadata.size) : 0;
  } catch {
    return null;
  }
}

export async function putCachedChunk(
  podcastId: string,
  episodeId: string,
  chunkIndex: number,
  data: Buffer,
): Promise<void> {
  const file = storageBucket.file(chunkPath(podcastId, episodeId, chunkIndex));
  await file.save(data, { contentType: "audio/ogg" });
}

export async function getCachedCompleteOgg(
  podcastId: string,
  episodeId: string,
): Promise<Buffer | null> {
  const file = storageBucket.file(completeOggPath(podcastId, episodeId));
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return contents;
}

export async function putCachedCompleteOgg(
  podcastId: string,
  episodeId: string,
  data: Buffer,
): Promise<void> {
  const file = storageBucket.file(completeOggPath(podcastId, episodeId));
  await file.save(data, { contentType: "audio/ogg" });
}

export async function deleteEpisodeAudio(podcastId: string, episodeId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/episodes/${episodeId}/audio/`;
  await storageBucket.deleteFiles({ prefix });
}

export async function deletePodcastAudio(podcastId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/`;
  await storageBucket.deleteFiles({ prefix });
}
