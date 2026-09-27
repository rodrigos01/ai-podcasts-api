import { storageBucket } from "../config/firebase";

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
  aac: Buffer,
): Promise<void> {
  const file = storageBucket.file(chunkPath(podcastId, episodeId, chunkIndex));
  await file.save(aac, {
    contentType: "audio/aac",
    metadata: { customTime: new Date().toISOString() },
  });
}

export async function deleteEpisodeAudio(podcastId: string, episodeId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/episodes/${episodeId}/audio/`;
  await storageBucket.deleteFiles({ prefix });
}

export async function deletePodcastAudio(podcastId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/`;
  await storageBucket.deleteFiles({ prefix });
}
