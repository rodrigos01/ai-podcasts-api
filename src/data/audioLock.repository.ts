import { randomUUID } from "node:crypto";
import { firestore } from "../config/firebase";
import { CHUNK_LOCK_TTL_MS } from "../constants/ttsLimits";

// One id per process — purely for a human inspecting the Firestore console
// to see which instance holds a lock; correctness comes entirely from the
// transaction below, not from this value.
const INSTANCE_ID = randomUUID();

function lockRef(podcastId: string, episodeId: string, index: number) {
  return firestore
    .collection("podcasts")
    .doc(podcastId)
    .collection("episodes")
    .doc(episodeId)
    .collection("audioLocks")
    .doc(String(index));
}

/**
 * Cross-instance equivalent of audio.service.ts's in-process
 * inFlightGenerations Map — that Map only dedupes concurrent requests
 * landing on the *same* Cloud Run instance; two requests for the same
 * not-yet-cached chunk landing on *different* instances would otherwise
 * both call the (costly) TTS API for it. The transaction gives us an
 * atomic "only one instance wins"; a lock older than CHUNK_LOCK_TTL_MS is
 * treated as abandoned (its holder crashed mid-generation) and stolen
 * rather than blocking every other instance forever.
 */
export async function tryAcquireChunkLock(
  podcastId: string,
  episodeId: string,
  index: number,
): Promise<boolean> {
  const ref = lockRef(podcastId, episodeId, index);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const startedAt = snap.data()?.startedAt as number | undefined;
      if (typeof startedAt === "number" && Date.now() - startedAt < CHUNK_LOCK_TTL_MS) {
        return false;
      }
    }
    tx.set(ref, { instanceId: INSTANCE_ID, startedAt: Date.now() });
    return true;
  });
}

export async function releaseChunkLock(
  podcastId: string,
  episodeId: string,
  index: number,
): Promise<void> {
  await lockRef(podcastId, episodeId, index).delete();
}


function locksCollection(podcastId: string, episodeId: string) {
  return firestore
    .collection("podcasts")
    .doc(podcastId)
    .collection("episodes")
    .doc(episodeId)
    .collection("audioLocks");
}

/** Whether some instance is generating a chunk of this episode right now (a lock past its TTL is abandoned). */
export async function hasActiveChunkLock(podcastId: string, episodeId: string): Promise<boolean> {
  const snap = await locksCollection(podcastId, episodeId).get();
  return snap.docs.some((doc) => {
    const startedAt = doc.data().startedAt as number | undefined;
    return typeof startedAt === "number" && Date.now() - startedAt < CHUNK_LOCK_TTL_MS;
  });
}

/** Removes every chunk lock of an episode (used when its audio is cleared, which leaves only abandoned ones). */
export async function clearChunkLocks(podcastId: string, episodeId: string): Promise<void> {
  const snap = await locksCollection(podcastId, episodeId).get();
  if (snap.empty) return;
  const batch = firestore.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
}
