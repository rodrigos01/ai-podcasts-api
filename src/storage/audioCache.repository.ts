import { storageBucket } from "../config/firebase";

// Each chunk starts as its own independent Ogg Opus stream from one
// streamingSynthesize call, but audio.service.ts's oggStitch rewrite (see
// utils/oggStitch.ts) patches it in place before it's ever cached here: a
// shared serial number, continuous page sequence, and continuous granule
// timeline, with duplicate OpusHead/OpusTags header pages dropped for every
// chunk after the first. What's stored under each chunk's key is therefore
// a *fragment* of one single continuous logical Ogg bitstream, not a
// standalone playable file on its own — concatenating the cached chunks in
// order reconstructs that one stream. See utils/oggOpus.ts for how a
// chunk's own last page (now an absolute, not per-chunk-relative, position)
// is used for time-based resume.
function chunkPath(podcastId: string, episodeId: string, chunkIndex: number): string {
  return `podcasts/${podcastId}/episodes/${episodeId}/audio/chunk-${chunkIndex}.opus`;
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

export async function deleteEpisodeAudio(podcastId: string, episodeId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/episodes/${episodeId}/audio/`;
  await storageBucket.deleteFiles({ prefix });
}

export async function deletePodcastAudio(podcastId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/`;
  await storageBucket.deleteFiles({ prefix });
}
