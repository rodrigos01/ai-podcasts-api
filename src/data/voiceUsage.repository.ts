import { firestore } from "../config/firebase";
import type { Person } from "../schemas/person.schema";

/**
 * Which of `voiceIds` are stored on a host of any podcast or a guest of any episode. People are
 * embedded arrays, which Firestore can't query by a nested field, so this reads the `hosts` /
 * `guests` of every podcast and episode (projected to just those fields).
 */
export async function findVoicesInUse(voiceIds: string[]): Promise<Set<string>> {
  const wanted = new Set(voiceIds);
  const inUse = new Set<string>();
  if (wanted.size === 0) return inUse;

  const note = (people: Person[] | undefined) => {
    for (const person of people ?? []) {
      if (person.resolvedVoiceId && wanted.has(person.resolvedVoiceId)) inUse.add(person.resolvedVoiceId);
    }
  };

  const [podcasts, episodes] = await Promise.all([
    firestore.collection("podcasts").select("hosts").get(),
    firestore.collectionGroup("episodes").select("guests").get(),
  ]);
  podcasts.forEach((doc) => note(doc.get("hosts") as Person[] | undefined));
  episodes.forEach((doc) => note(doc.get("guests") as Person[] | undefined));
  return inUse;
}
