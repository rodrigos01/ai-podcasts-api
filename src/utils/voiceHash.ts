import { createHash } from "node:crypto";
import type { Person } from "../schemas/person.schema";

type HashedFields = Pick<Person, "name" | "persona" | "accent" | "voice">;

// Bumped whenever previously-stored `voice_...` ids stop being valid (e.g.
// the 2026-10 move from the AI Studio Voices API to the Gemini Enterprise
// Agent Platform's — a voice designed on one doesn't exist on the other).
// Mixed into voiceHash so every host's cached voice is treated as stale and
// re-designed once on its next use, instead of reusing an id the current
// backend has never heard of.
export const VOICE_BACKEND_VERSION = "enterprise-1";

/**
 * Detects a stale cached voice — an edit to name/persona/accent/voice hint
 * should trigger a fresh Voice Design call, not silently keep reusing a voice
 * designed for the old text. (The voice hint isn't in the design prompt any
 * more but stays in the hash so existing voices stay valid; an edit to it
 * costs one redundant, harmless re-design. People saved while English
 * persona/accent fields existed hashed with them appended; those fields are
 * gone, so such a person's voice is re-designed once on its next use.)
 */
export function voiceHash(person: HashedFields): string {
  return createHash("sha256")
    .update(
      `${VOICE_BACKEND_VERSION}\u0000${person.name}\u0000${person.persona}\u0000${person.accent ?? ""}\u0000${person.voice}`,
    )
    .digest("hex");
}

/**
 * True when `person` already has a stored voice that's still valid: an id,
 * recorded under the same hash `voiceHash` computes today (same backend
 * version, same name/persona/accent/hint). Anything else — no id, no hash
 * (a voice stored before hashes were recorded, or on another platform) or a
 * different one — means the stored id can't be trusted and a fresh voice
 * must be designed. Applies to hosts and guests alike.
 */
export function hasCurrentVoice(person: Person): person is Person & { resolvedVoiceId: string } {
  if (!person.resolvedVoiceId) return false;
  // A voice the user picked stays valid whatever the text now says: it's only
  // dropped when they pick another, or when an edit changes the prompt it was
  // designed from (see voiceDecision.ts).
  if (person.resolvedVoicePinned) return true;
  return person.resolvedVoiceHash === voiceHash(person);
}

