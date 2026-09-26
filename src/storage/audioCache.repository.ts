import { storageBucket } from "../config/firebase";

// Each chunk is encoded independently (audio.service.ts spawns its own
// short-lived ffmpeg process per chunk — see utils/aacEncoder.ts) into ADTS
// AAC, migrated 2026-09-26 from Ogg Opus (see AGENTS.md). Unlike the old Ogg
// Opus chunks, which needed audio.service.ts's oggStitch rewrite to erase
// each chunk's own header/serial-number/page-sequence state before caching,
// an ADTS AAC chunk needs no such rewriting: every frame is self-delimited
// with no shared "logical stream" concept to reconcile across chunks, so
// what's stored here is exactly the encoder's own output, and each cached
// file is independently decodable/playable on its own — concatenating them
// in order still reconstructs the whole episode, but no single cached file
// depends on any other's bytes the way a stitched Ogg fragment did. See
// utils/adts.ts for how a chunk's own frame count is used for time-based
// resume.
function chunkPath(podcastId: string, episodeId: string, chunkIndex: number): string {
  return `podcasts/${podcastId}/episodes/${episodeId}/audio/chunk-${chunkIndex}.aac`;
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
  await file.save(data, { contentType: "audio/aac" });
}

export async function deleteEpisodeAudio(podcastId: string, episodeId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/episodes/${episodeId}/audio/`;
  await storageBucket.deleteFiles({ prefix });
}

export async function deletePodcastAudio(podcastId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/`;
  await storageBucket.deleteFiles({ prefix });
}
