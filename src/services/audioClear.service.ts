import { clearChunkLocks, hasActiveChunkLock } from "../data/audioLock.repository";
import { bumpAudioEpoch, clearUnpinnedGuestVoices, patchEpisodeState } from "../data/episode.repository";
import type { Episode } from "../schemas/episode.schema";
import { deleteEpisodeAudio, listEpisodeAudioFiles } from "../storage/audioCache.repository";
import { assertAudioClearable } from "../utils/audioClear";
import { abortLocalGenerations, waitUntil } from "../utils/audioCancellation";
import { HttpError } from "../utils/HttpError";
import { cleanupGuestVoice } from "./episodeGeneration/voiceResolution.service";

// How long to wait for a cancelled generation to let go of its chunk lock. A generation on this
// instance stops at once; one on another instance notices within its epoch poll interval.
const STOP_TIMEOUT_MS = 15_000;
const STOP_POLL_INTERVAL_MS = 250;

/**
 * Stops every audio generation of the episode: bumps its audio epoch (so generations and
 * listeners on any instance give up), aborts the ones running on this process, and waits until
 * none holds a chunk lock any more.
 */
async function stopAudioGeneration(podcastId: string, episodeId: string): Promise<void> {
  await bumpAudioEpoch(podcastId, episodeId);
  abortLocalGenerations(podcastId, episodeId);
  const stopped = await waitUntil(
    async () => !(await hasActiveChunkLock(podcastId, episodeId)),
    STOP_TIMEOUT_MS,
    STOP_POLL_INTERVAL_MS,
  );
  if (!stopped) {
    throw HttpError.conflict("Audio generation could not be stopped in time; try again in a moment.");
  }
}

/**
 * Throws away an episode's cached audio — and the audio settings that go with it — without
 * touching its script, so the next `/stream` synthesizes it again (e.g. after a voice was
 * changed). Audio that is being generated at that moment is cancelled first, and the listeners
 * it was streaming to are disconnected (a player retrying then gets the fresh audio).
 *
 * The audio settings are the generated-audio counter, the completion flag and exact duration
 * clients use to tell a finished file from a live stream, and the stored chunking, plus any
 * leftover chunk locks and the temporary voice of a guest the user didn't pick one for (it is
 * designed again when the audio is generated).
 */
export async function clearEpisodeAudio(podcastId: string, episodeId: string, episode: Episode): Promise<void> {
  assertAudioClearable(episode.status);

  // Twice: a player that was cut off by the first stop reconnects right away, and what that
  // request starts before the files are gone is stopped and deleted by the second pass. Leftover
  // locks go before the second stop, which waits for any new generation to let go of its own.
  await stopAudioGeneration(podcastId, episodeId);
  await deleteEpisodeAudio(podcastId, episodeId);
  await clearChunkLocks(podcastId, episodeId);
  await stopAudioGeneration(podcastId, episodeId);
  await deleteEpisodeAudio(podcastId, episodeId);

  // Verify rather than assume: audio left behind would be served (and marked complete) as if the
  // clear had never happened.
  const remaining = await listEpisodeAudioFiles(podcastId, episodeId);
  if (remaining.length > 0) {
    console.error(`Audio of ${podcastId}/${episodeId} survived the clear:`, remaining);
    throw HttpError.conflict("Some cached audio could not be removed; try again in a moment.");
  }

  // Everything that could write audio state under the old epoch is stopped, and a late write from
  // one is ignored (the epoch guard), so this reset sticks.
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
