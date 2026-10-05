import type { Person, PersonInput, ResolvedVoiceFields } from "../schemas/person.schema";
import { voiceHash } from "./voiceHash";

export const NO_VOICE: ResolvedVoiceFields = {
  resolvedVoiceId: null,
  resolvedVoiceOrigin: null,
  resolvedVoiceHash: null,
};

// A voice the user picked from a design session, as recorded when it was designed.
export interface PickedVoice {
  voiceId: string;
  prompt: string;
}

export interface VoiceDecision {
  /** The voice fields to store; null means keep whatever the person has now. */
  fields: ResolvedVoiceFields | null;
  /** Set when a pick replaces the prompt: the prompt the picked voice was designed from. */
  voicePrompt?: string;
  /** A stored voice of ours that this decision leaves unused. */
  replacedVoiceId?: string;
}

/**
 * What a save does with a person's voice, given the stored person (if any),
 * the incoming one (already prepared: English fields and prompt settled) and
 * the user's pick — which the caller has already validated against the
 * caller's own design session, so an unknown/stale id arrives here as `null`,
 * the same as no pick at all:
 *
 *  - a pick wins: it's stored, pinned, along with the prompt it was designed
 *    from (so the stored prompt always describes the stored voice);
 *  - no pick, but the prompt differs from the one stored: the stored voice was
 *    designed from different text, so it's dropped and the usual lazy path
 *    designs a new one from the new prompt at the next generation. (A person
 *    stored without a prompt is never touched here — the hash covers them.)
 *  - otherwise the voice is left alone.
 *
 * Never reads or trusts a client-sent `resolvedVoiceId`.
 */
export function decideVoice(
  current: Person | undefined,
  incoming: Pick<PersonInput, "name" | "persona" | "accent" | "voice" | "personaEn" | "accentEn" | "voicePrompt">,
  pick: PickedVoice | null,
): VoiceDecision {
  const replaced = ownedVoiceId(current);

  if (pick) {
    const person = { ...incoming, voicePrompt: pick.prompt };
    return {
      fields: {
        resolvedVoiceId: pick.voiceId,
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: voiceHash(person),
        resolvedVoicePinned: true,
      },
      voicePrompt: pick.prompt,
      ...(replaced && replaced !== pick.voiceId ? { replacedVoiceId: replaced } : {}),
    };
  }

  const promptChanged =
    !!current?.voicePrompt && !!incoming.voicePrompt && incoming.voicePrompt !== current.voicePrompt;
  if (promptChanged && current?.resolvedVoiceId) {
    return {
      fields: { ...NO_VOICE, resolvedVoicePinned: false },
      ...(replaced ? { replacedVoiceId: replaced } : {}),
    };
  }

  return { fields: null };
}

// A stored voice id that's ours to delete: one recorded under a hash (this
// platform). A null hash is a voice from before the platform move — foreign,
// and a delete would only fail.
function ownedVoiceId(person: Person | undefined): string | undefined {
  return person?.resolvedVoiceId && person.resolvedVoiceHash ? person.resolvedVoiceId : undefined;
}
