import { clearChunkLocks, hasActiveChunkLock } from "../data/audioLock.repository";
import { clearUnpinnedGuestVoices, patchEpisodeState } from "../data/episode.repository";
import type { Episode } from "../schemas/episode.schema";
import { deleteEpisodeAudio } from "../storage/audioCache.repository";
import { assertAudioClearable } from "../utils/audioClear";
import { cleanupGuestVoice } from "./episodeGeneration/voiceResolution.service";

/**
 * Throws away an episode's cached audio — and the audio settings that go with it — without
 * touching its script, so the next `/stream` synthesizes it again (e.g. after a voice was
 * changed). The audio settings are the generated-audio counter, the completion flag and exact duration
 * clients use to tell a finished file from a live stream, and the stored chunking, plus
 * any leftover chunk locks and the temporary voice of a guest the user didn't pick one for
 * (it is designed again when the audio is generated).
 */
export async function clearEpisodeAudio(podcastId: string, episodeId: string, episode: Episode): Promise<void> {
  assertAudioClearable(episode.status, await hasActiveChunkLock(podcastId, episodeId));

  await deleteEpisodeAudio(podcastId, episodeId);
  await clearChunkLocks(podcastId, episodeId);
  await patchEpisodeState(podcastId, episodeId, {
    ttsChunks: null,
    generatedAudioSeconds: 0,
    audioComplete: false,
    audioDurationSeconds: null,
  });

  // Best-effort: a leaked temporary voice expires on its own.
  const guests = await clearUnpinnedGuestVoices(podcastId, episodeId);
  await Promise.all(guests.map((guest) => cleanupGuestVoice(guest)));
}
