import { storageBucket } from "../config/firebase";

function chunkPath(podcastId: string, episodeId: string, chunkIndex: number): string {
  return `podcasts/${podcastId}/episodes/${episodeId}/audio/chunk-${chunkIndex}.aac`;
}

export async function getCachedChunk(
  podcastId: string,
  episodeId: string,
  chunkIndex: number,
): Promise<Buffer | null> {
  // Not `file.download()`: the Storage SDK's stream-based download (teeny-request's PassThrough +
  // pipeline) attaches 11+ listeners to one stream per call, so every download logged a
  // MaxListenersExceededWarning. A plain authenticated GET of the media endpoint returns the same
  // bytes with no stream, and its 404 doubles as the existence check (one round trip, not two).
  const url =
    `https://storage.googleapis.com/storage/v1/b/${storageBucket.name}/o/` +
    `${encodeURIComponent(chunkPath(podcastId, episodeId, chunkIndex))}?alt=media`;
  const res = await storageBucket.storage.authClient.request<ArrayBuffer>({
    url,
    responseType: "arraybuffer",
    validateStatus: (status) => status === 200 || status === 404,
  });
  return res.status === 404 ? null : Buffer.from(res.data);
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

/** Names of the episode's cached audio files that currently exist. */
export async function listEpisodeAudioFiles(podcastId: string, episodeId: string): Promise<string[]> {
  const [files] = await storageBucket.getFiles({ prefix: `podcasts/${podcastId}/episodes/${episodeId}/audio/` });
  return files.map((file) => file.name);
}

export async function deleteEpisodeAudio(podcastId: string, episodeId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/episodes/${episodeId}/audio/`;
  await storageBucket.deleteFiles({ prefix });
}

export async function deletePodcastAudio(podcastId: string): Promise<void> {
  const prefix = `podcasts/${podcastId}/`;
  await storageBucket.deleteFiles({ prefix });
}
