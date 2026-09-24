import { randomUUID } from "node:crypto";
import { firestore } from "../config/firebase";
import { AUDIO_GENERATION_LOCK_TTL_MS } from "../constants/ttsLimits";

// One id per process — purely for a human inspecting the Firestore console
// to see which instance holds a lock; correctness comes entirely from the
// transaction below, not from this value.
const INSTANCE_ID = randomUUID();

// One lock per episode now, not per chunk — the Gemini 3.8 Flash TTS
// migration replaced per-chunk generation with a single streaming
// synthesis call for an episode's whole transcript (see ttsLimits.ts,
// llm/ttsClient.ts). A single "audioGeneration" doc under the episode
// covers the whole job.
function lockRef(podcastId: string, episodeId: string) {
  return firestore
    .collection("podcasts")
    .doc(podcastId)
    .collection("episodes")
    .doc(episodeId)
    .collection("audioLocks")
    .doc("generation");
}

/**
 * Cross-instance equivalent of audio.service.ts's in-process leader/
 * follower bookkeeping — without this, two requests for the same
 * not-yet-generated episode landing on *different* Cloud Run instances
 * would otherwise both start a (costly, long-running) TTS synthesis call
 * for it. The transaction gives us an atomic "only one instance wins"; a
 * lock older than AUDIO_GENERATION_LOCK_TTL_MS is treated as abandoned (its
 * holder crashed mid-generation) and stolen rather than blocking every
 * other instance forever.
 */
export async function tryAcquireAudioGenerationLock(podcastId: string, episodeId: string): Promise<boolean> {
  const ref = lockRef(podcastId, episodeId);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const startedAt = snap.data()?.startedAt as number | undefined;
      if (typeof startedAt === "number" && Date.now() - startedAt < AUDIO_GENERATION_LOCK_TTL_MS) {
        return false;
      }
    }
    tx.set(ref, { instanceId: INSTANCE_ID, startedAt: Date.now() });
    return true;
  });
}

export async function releaseAudioGenerationLock(podcastId: string, episodeId: string): Promise<void> {
  await lockRef(podcastId, episodeId).delete();
}
