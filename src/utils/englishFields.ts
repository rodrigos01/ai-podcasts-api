import type { PersonInput } from "../schemas/person.schema";

type EnglishSource = Pick<PersonInput, "persona" | "accent" | "personaEn" | "accentEn">;

/**
 * Decides which English persona/accent (see person.schema.ts) a host keeps
 * when a client updates them. An English field only means anything next to
 * the original it was written from, so:
 *  - the client sent one that differs from what's stored → it's a deliberate
 *    new value, keep it;
 *  - the original is unchanged and the client omitted the English one (or
 *    echoed it back) → keep the stored one, so a client that doesn't know
 *    these fields doesn't wipe them;
 *  - the original changed but the English one wasn't touched → it's stale,
 *    drop it, and voiceResolution.service.ts translates on demand instead.
 * Returns only the keys that should be set (Firestore rejects `undefined`).
 */
export function reconcileEnglishFields(
  current: EnglishSource,
  incoming: EnglishSource,
): { personaEn?: string; accentEn?: string } {
  const personaEn = reconcile(current.persona, current.personaEn, incoming.persona, incoming.personaEn);
  const accentEn = reconcile(current.accent, current.accentEn, incoming.accent, incoming.accentEn);
  return { ...(personaEn ? { personaEn } : {}), ...(accentEn ? { accentEn } : {}) };
}

function reconcile(
  currentOriginal: string | undefined,
  currentEnglish: string | undefined,
  incomingOriginal: string | undefined,
  incomingEnglish: string | undefined,
): string | undefined {
  if (incomingEnglish !== undefined && incomingEnglish !== currentEnglish) return incomingEnglish;
  return incomingOriginal === currentOriginal ? currentEnglish : undefined;
}
