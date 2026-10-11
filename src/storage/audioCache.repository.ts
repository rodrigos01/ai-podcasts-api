import { storageBucket } from "../config/firebase";
import { AUDIO_URL_TTL_SECONDS } from "../utils/audioUrl";

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

function audioPrefix(podcastId: string, episodeId: string): string {
  return `podcasts/${podcastId}/episodes/${episodeId}/audio/`;
}

function finalPath(podcastId: string, episodeId: string): string {
  return `${audioPrefix(podcastId, episodeId)}final.aac`;
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

// GCS composes at most 32 source objects per request.
const MAX_COMPOSE_SOURCES = 32;

/**
 * Concatenates the episode's first `chunkCount` cached chunks into the single `final.aac`, inside
 * Storage (no bytes are downloaded). ADTS frames are self-contained, so concatenated chunks are a
 * valid stream. Throws if a chunk is missing. More than 32 chunks are composed in tiers through
 * temporary `final-part-*.aac` objects, which are removed again.
 */
export async function composeFinalAudio(podcastId: string, episodeId: string, chunkCount: number): Promise<void> {
  const prefix = audioPrefix(podcastId, episodeId);
  const parts: string[] = [];
  let sources = Array.from({ length: chunkCount }, (_, i) => chunkPath(podcastId, episodeId, i));
  try {
    for (let tier = 0; sources.length > MAX_COMPOSE_SOURCES; tier++) {
      const composed: string[] = [];
      for (let i = 0; i < sources.length; i += MAX_COMPOSE_SOURCES) {
        const name = `${prefix}final-part-${tier}-${i / MAX_COMPOSE_SOURCES}.aac`;
        parts.push(name);
        const part = storageBucket.file(name);
        part.metadata = { contentType: "audio/aac" };
        await storageBucket.combine(sources.slice(i, i + MAX_COMPOSE_SOURCES), part);
        composed.push(name);
      }
      sources = composed;
    }
    const final = storageBucket.file(finalPath(podcastId, episodeId));
    final.metadata = { contentType: "audio/aac" };
    await storageBucket.combine(sources, final);
    // So the lifecycle rules count from when it was written, like the chunks (see putCachedChunk).
    await final.setMetadata({ customTime: new Date().toISOString() });
  } finally {
    await Promise.all(parts.map((name) => storageBucket.file(name).delete({ ignoreNotFound: true })));
  }
}

export async function getFinalAudioSize(podcastId: string, episodeId: string): Promise<number | null> {
  try {
    const [metadata] = await storageBucket.file(finalPath(podcastId, episodeId)).getMetadata();
    return metadata.size ? Number(metadata.size) : 0;
  } catch (err) {
    if ((err as { code?: number }).code === 404) return null;
    throw err;
  }
}

export async function deleteFinalAudio(podcastId: string, episodeId: string): Promise<void> {
  await storageBucket.file(finalPath(podcastId, episodeId)).delete({ ignoreNotFound: true });
}

/**
 * A time-limited URL that serves `final.aac` straight from Storage, with native Range support and
 * a real Content-Length; the object stays private. Valid as long as the `/stream` token URLs are
 * (`AUDIO_URL_TTL_SECONDS`). `expiresAt` is unix seconds. In a deployed environment signing goes
 * through IAM, so the runtime service account needs `iam.serviceAccounts.signBlob` on itself
 * (e.g. roles/iam.serviceAccountTokenCreator); locally the service-account key signs.
 */
export async function getFinalAudioSignedUrl(
  podcastId: string,
  episodeId: string,
): Promise<{ url: string; expiresAt: number }> {
  const expiresMs = Date.now() + AUDIO_URL_TTL_SECONDS * 1000;
  const [url] = await storageBucket.file(finalPath(podcastId, episodeId)).getSignedUrl({
    version: "v4",
    action: "read",
    expires: expiresMs,
    responseType: "audio/aac",
  });
  return { url, expiresAt: Math.floor(expiresMs / 1000) };
}
