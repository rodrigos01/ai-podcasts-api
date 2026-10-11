import { clearUnpinnedGuestVoices } from "../../data/episode.repository";
import { cleanupGuestVoice } from "./voiceResolution.service";

/**
 * Runs once, after an episode's audio chunks have fully and successfully completed.
 * Cleans up the episode's guest's voice if it was a Voice-Design mint (never for a
 * Library voice — see voiceResolution.service.ts's cleanupGuestVoice).
 * Deliberately NOT called on a failed attempt: the guest's already-resolved voice stays
 * valid and reusable for a retry.
 */
export async function finalizeEpisodeAudio(podcastId: string, episodeId: string): Promise<void> {
  // Forget the stored id in the same step (atomically) as claiming it for deletion: this runs
  // after every complete playback, and the second one must find nothing left to delete rather
  // than deleting the already-deleted voice again (a 404 from the Voices API).
  const guests = await clearUnpinnedGuestVoices(podcastId, episodeId);
  await Promise.all(guests.map((guest) => cleanupGuestVoice(guest)));
}
