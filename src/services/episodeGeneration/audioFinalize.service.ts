import { getEpisode } from "../../data/episode.repository";
import { cleanupGuestVoice } from "./voiceResolution.service";

/**
 * Runs once, after an episode's audio chunks have fully and successfully completed.
 * Cleans up the episode's guest's voice if it was a Voice-Design mint (never for a
 * Library voice — see voiceResolution.service.ts's cleanupGuestVoice).
 * Deliberately NOT called on a failed attempt: the guest's already-resolved voice stays
 * valid and reusable for a retry.
 */
export async function finalizeEpisodeAudio(podcastId: string, episodeId: string): Promise<void> {
  const episode = await getEpisode(podcastId, episodeId);
  const guest = episode?.guests[0];
  if (guest) await cleanupGuestVoice(guest);
}
