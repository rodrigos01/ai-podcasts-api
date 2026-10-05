import { firestore } from "../config/firebase";

// Registry of every Voice Design voice created through POST /voices/design,
// grouped by the `sessionId` the client sent: a wizard run's id (minted by
// the wizard responses), or a podcast/episode id when editing an existing
// one. The voice id is the document id. Every lookup is scoped by owner as
// well as session, so a session id can never reach another user's voices —
// it needn't be secret, and nobody can block or clean up someone else's.
export interface DesignedVoice {
  voiceId: string;
  sessionId: string;
  ownerId: string;
  prompt: string;
  // Set once the voice is stored on a podcast host or episode guest. Linked
  // voices are never cleaned up with their session (a session id is the
  // podcast/episode id when editing, so it outlives the pick). Absent on
  // records written before this field existed, which means false.
  linked?: boolean;
  createdAt: number;
}

const designedVoicesCollection = firestore.collection("designedVoices");

export async function registerDesignedVoices(voices: DesignedVoice[]): Promise<void> {
  const batch = firestore.batch();
  for (const voice of voices) batch.set(designedVoicesCollection.doc(voice.voiceId), voice);
  await batch.commit();
}

// Equality filters only, so no composite index is needed.
export async function listSessionVoices(sessionId: string, ownerId: string): Promise<DesignedVoice[]> {
  const snap = await designedVoicesCollection
    .where("sessionId", "==", sessionId)
    .where("ownerId", "==", ownerId)
    .get();
  return snap.docs.map((doc) => doc.data() as DesignedVoice);
}

export async function markVoicesLinked(voiceIds: string[]): Promise<void> {
  if (voiceIds.length === 0) return;
  const batch = firestore.batch();
  for (const id of voiceIds) batch.set(designedVoicesCollection.doc(id), { linked: true }, { merge: true });
  await batch.commit();
}

/** Removes registry records (a record that doesn't exist is fine). */
export async function deleteDesignedVoiceRecords(voiceIds: string[]): Promise<void> {
  if (voiceIds.length === 0) return;
  const batch = firestore.batch();
  for (const id of voiceIds) batch.delete(designedVoicesCollection.doc(id));
  await batch.commit();
}
