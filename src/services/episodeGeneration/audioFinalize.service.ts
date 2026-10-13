import { clearUnpinnedGuestVoices, getAudioEpoch, getEpisode } from "../../data/episode.repository";
import {
  composeFinalAudio,
  deleteFinalAudio,
  getFinalAudioSize,
} from "../../storage/audioCache.repository";
import { chunkTranscript } from "./chunker";
import { cleanupGuestVoice } from "./voiceResolution.service";

/**
 * Runs after an episode's audio chunks have fully and successfully completed, and again after
 * every complete playback (and whenever `/audio/url` finds the episode complete but not yet
 * consolidated), so every step is idempotent:
 *  - cleans up the episode's guest's voice if it was a Voice-Design mint (never for a Library
 *    voice — see voiceResolution.service.ts's cleanupGuestVoice);
 *  - consolidates the chunks into the single `final.aac` that `/audio/url` hands out a signed
 *    Storage URL for.
 * Deliberately NOT called on a failed attempt: the guest's already-resolved voice stays
 * valid and reusable for a retry.
 */
export async function finalizeEpisodeAudio(podcastId: string, episodeId: string): Promise<void> {
  // Forget the stored id in the same step (atomically) as claiming it for deletion: this runs
  // after every complete playback, and the second one must find nothing left to delete rather
  // than deleting the already-deleted voice again (a 404 from the Voices API).
  const guests = await clearUnpinnedGuestVoices(podcastId, episodeId);
  await Promise.all(guests.map((guest) => cleanupGuestVoice(guest)));

  await consolidateAudio(podcastId, episodeId);
}

/** In-flight consolidations on this process instance, so concurrent callers share one. */
const consolidationInFlight = new Map<string, Promise<void>>();

function consolidateAudio(podcastId: string, episodeId: string): Promise<void> {
  const key = `${podcastId}:${episodeId}`;
  const existing = consolidationInFlight.get(key);
  if (existing) return existing;
  const promise = consolidateAudioOnce(podcastId, episodeId).finally(() => consolidationInFlight.delete(key));
  consolidationInFlight.set(key, promise);
  return promise;
}

async function consolidateAudioOnce(podcastId: string, episodeId: string): Promise<void> {
  const episode = await getEpisode(podcastId, episodeId);
  // `audioComplete` is the "every chunk is cached" fact: nothing to consolidate before it. "ready"
  // too, so an episode that is still being written is never consolidated from the chunks sealed
  // so far (a truncated file).
  if (!episode?.audioComplete || episode.status !== "ready" || !episode.transcript) return;
  if ((await getFinalAudioSize(podcastId, episodeId)) !== null) return;

  const chunkCount = episode.ttsChunks?.length ? episode.ttsChunks.length : chunkTranscript(episode.transcript).length;
  const startEpoch = await getAudioEpoch(podcastId, episodeId);
  await composeFinalAudio(podcastId, episodeId, chunkCount);
  // A clear that landed meanwhile has deleted (or is deleting) the audio this was built from:
  // the consolidated file must not outlive it.
  if ((await getAudioEpoch(podcastId, episodeId)) !== startEpoch) await deleteFinalAudio(podcastId, episodeId);
}
