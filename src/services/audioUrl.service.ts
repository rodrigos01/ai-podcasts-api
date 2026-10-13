import type { Episode } from "../schemas/episode.schema";
import { getFinalAudioSignedUrl, getFinalAudioSize } from "../storage/audioCache.repository";
import { signedEpisodeAudioUrl } from "../utils/audioUrl";
import { finalizeEpisodeAudio } from "./episodeGeneration/audioFinalize.service";

/**
 * The URL a client should play (and cast) for an episode: once its audio is complete
 * (`audioComplete` on a `ready` episode), a signed Storage URL for the consolidated `final.aac` — Storage serves it as
 * a plain static file; until then, the `/stream/<token>` URL, which generates audio on demand.
 *
 * An episode that is complete but not consolidated yet (finalize runs when a playback ends, so
 * this can be asked first) is consolidated here. If that or the signing fails, the `/stream` URL
 * is still correct for a complete episode (it serves the cached chunks), so the failure is logged
 * and the caller isn't left without a URL.
 */
export async function resolveEpisodeAudioUrl(
  origin: string,
  podcastId: string,
  episodeId: string,
  episode: Pick<Episode, "audioComplete" | "status">,
  streamSecret: string,
): Promise<{ url: string; expiresAt: number }> {
  // "ready" too: the audio can only be complete once the script is, whatever a stale flag says.
  if (episode.audioComplete === true && episode.status === "ready") {
    try {
      if ((await getFinalAudioSize(podcastId, episodeId)) === null) {
        await finalizeEpisodeAudio(podcastId, episodeId);
        if ((await getFinalAudioSize(podcastId, episodeId)) === null) {
          throw new Error("final.aac is still missing after finalize");
        }
      }
      return await getFinalAudioSignedUrl(podcastId, episodeId);
    } catch (err) {
      console.error(`Could not hand out the consolidated audio URL for ${podcastId}/${episodeId}:`, err);
    }
  }
  return signedEpisodeAudioUrl(origin, podcastId, episodeId, streamSecret);
}
