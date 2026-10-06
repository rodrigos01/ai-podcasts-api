import type { PersonInput } from "../schemas/person.schema";

type EnglishSource = Pick<PersonInput, "persona" | "voice" | "accent" | "personaEn" | "accentEn">;
type PromptSource = EnglishSource & Pick<PersonInput, "name" | "voicePrompt">;

/**
 * True when something the English fields are derived from changed. Both
 * English fields come from the persona, voice hint and accent together (an
 * accent is often only mentioned in the hint), so an edit to any of them
 * makes both stale.
 */
export function englishSourceChanged(current: EnglishSource, incoming: EnglishSource): boolean {
  return (
    current.persona !== incoming.persona ||
    current.voice !== incoming.voice ||
    current.accent !== incoming.accent
  );
}

/**
 * Decides which English persona/accent (see person.schema.ts) a host keeps
 * when a client updates them:
 *  - the client sent one that differs from what's stored → it's a deliberate
 *    new value, keep it;
 *  - nothing it was derived from changed and the client omitted the English
 *    one (or echoed it back) → keep the stored one, so a client that doesn't
 *    know these fields doesn't wipe them;
 *  - the persona, voice hint or accent changed but the English one wasn't
 *    touched → it's stale, drop it (personEnglish.service.ts then writes a
 *    fresh one).
 * Returns only the keys that should be set (Firestore rejects `undefined`).
 */
export function reconcileEnglishFields(
  current: EnglishSource,
  incoming: EnglishSource,
): { personaEn?: string; accentEn?: string } {
  const changed = englishSourceChanged(current, incoming);
  const personaEn = reconcile(current.personaEn, incoming.personaEn, changed);
  const accentEn = reconcile(current.accentEn, incoming.accentEn, changed);
  return { ...(personaEn ? { personaEn } : {}), ...(accentEn ? { accentEn } : {}) };
}

/**
 * The same decision as reconcileEnglishFields, for the stored Voice Design
 * prompt: a deliberate new value from the client wins; otherwise the stored
 * one is kept unless something it's built from changed — the name too, since
 * the prompt opens with it — in which case it's dropped and rebuilt.
 */
export function reconcileVoicePrompt(current: PromptSource, incoming: PromptSource): string | undefined {
  const stale = englishSourceChanged(current, incoming) || current.name !== incoming.name;
  return reconcile(current.voicePrompt, incoming.voicePrompt, stale);
}

function reconcile(
  currentEnglish: string | undefined,
  incomingEnglish: string | undefined,
  sourceChanged: boolean,
): string | undefined {
  if (incomingEnglish !== undefined && incomingEnglish !== currentEnglish) return incomingEnglish;
  return sourceChanged ? undefined : currentEnglish;
}
