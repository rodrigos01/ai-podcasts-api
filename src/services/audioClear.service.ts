import { clearChunkLocks, hasActiveChunkLock } from "../data/audioLock.repository";
import { clearUnpinnedGuestVoices, patchEpisodeState } from "../data/episode.repository";
import type { Episode } from "../schemas/episode.schema";
import { deleteEpisodeAudio } from "../storage/audioCache.repository";
import { HttpError } from "../utils/HttpError";
import { cleanupGuestVoice } from "./episodeGeneration/voiceResolution.service";

/**
 * Whether an episode's audio can be cleared right now. Not while the script is still being
 * written (the orchestrator owns the episode's state then), nor while a listener's request
 * is synthesizing a chunk (it would write that chunk back after the delete).
 */
export function assertAudioClearable(status: Episode["status"], chunkBeingGenerated: boolean): void {
  if (status === "generating") {
    throw HttpError.conflict("The episode is still being generated; there is no audio to clear yet.");
  }
  if (chunkBeingGenerated) {
    throw HttpError.conflict("Audio is being generated right now; try again once it has finished.");
  }
}

/**
 * Throws away an episode's cached audio — and the audio settings that go with it — without
 * touching its script, so the next `/stream` synthesizes it again (e.g. after a voice was
 * changed). The audio settings are the generated-audio counter and the stored chunking, plus
 * any leftover chunk locks and the temporary voice of a guest the user didn't pick one for
 * (it is designed again when the audio is generated).
 */
export async function clearEpisodeAudio(podcastId: string, episodeId: string, episode: Episode): Promise<void> {
  assertAudioClearable(episode.status, await hasActiveChunkLock(podcastId, episodeId));

  await deleteEpisodeAudio(podcastId, episodeId);
  await clearChunkLocks(podcastId, episodeId);
  await patchEpisodeState(podcastId, episodeId, { ttsChunks: null, generatedAudioSeconds: 0 });

  // Best-effort: a leaked temporary voice expires on its own.
  const guests = await clearUnpinnedGuestVoices(podcastId, episodeId);
  await Promise.all(guests.map((guest) => cleanupGuestVoice(guest)));
}
