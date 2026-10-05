import { createHash } from "node:crypto";
import { deleteVoice, designVoice } from "../../llm/ttsClient";
import { setHostResolvedVoice, setHostVoicePrompt } from "../../data/podcast.repository";
import { setGuestResolvedVoice, setGuestVoicePrompt } from "../../data/episode.repository";
import type { Person } from "../../schemas/person.schema";
import { withVoicePrompt } from "../personEnglish.service";

export interface ResolvedVoice {
  voiceId: string;
}

// Bumped whenever previously-stored `voice_...` ids stop being valid (e.g.
// the 2026-10 move from the AI Studio Voices API to the Gemini Enterprise
// Agent Platform's — a voice designed on one doesn't exist on the other).
// Mixed into voiceHash so every host's cached voice is treated as stale and
// re-designed once on its next use, instead of reusing an id the current
// backend has never heard of.
const VOICE_BACKEND_VERSION = "enterprise-1";

/**
 * Detects a stale cached voice — an edit to name/persona/accent/voice hint
 * (or to their English counterparts) should trigger a fresh Voice Design
 * call, not silently keep reusing a voice designed for the old text. Same
 * pattern as the investigation spike's own `voiceCacheKey`.
 *
 * The English fields are appended only when present, so a person who has
 * none hashes exactly as before they existed — every voice already stored
 * stays valid instead of the whole catalogue being re-designed. (The voice
 * hint is no longer sent to Voice Design but stays in the hash for the same
 * reason; an edit to it costs one redundant, harmless re-design.)
 */
function voiceHash(person: Person): string {
  const english =
    person.personaEn || person.accentEn
      ? `\u0000${person.personaEn ?? ""}\u0000${person.accentEn ?? ""}`
      : "";
  return createHash("sha256")
    .update(
      `${VOICE_BACKEND_VERSION}\u0000${person.name}\u0000${person.persona}\u0000${person.accent ?? ""}\u0000${person.voice}${english}`,
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
  return !!person.resolvedVoiceId && person.resolvedVoiceHash === voiceHash(person);
}

/**
 * Designs from the person's stored Voice Design prompt. A person without one
 * (saved before prompts were stored) gets it written first — and persisted via
 * `persist` before the design call, so a failed attempt doesn't lose it.
 */
async function designFor(
  person: Person,
  persist: (voicePrompt: string) => Promise<void>,
): Promise<ResolvedVoice> {
  let voicePrompt = person.voicePrompt;
  if (!voicePrompt) {
    voicePrompt = (await withVoicePrompt(person)).voicePrompt;
    await persist(voicePrompt);
  }
  const voiceId = await designVoice({ voiceDescription: voicePrompt });
  return { voiceId };
}

/**
 * Hosts get a bespoke Voice Design voice, persisted on the Podcast document
 * and reused for every future episode — designing one is a real, billed
 * LLM + Voice Design call, so this only happens once per host (until their
 * persona/accent/voice hint actually changes) rather than per episode.
 */
export async function resolveHostVoice(podcastId: string, host: Person): Promise<ResolvedVoice> {
  if (hasCurrentVoice(host)) {
    return { voiceId: host.resolvedVoiceId };
  }

  const resolved = await designFor(host, (prompt) => setHostVoicePrompt(podcastId, host.id, prompt));
  await setHostResolvedVoice(podcastId, host.id, {
    resolvedVoiceId: resolved.voiceId,
    resolvedVoiceOrigin: "design",
    resolvedVoiceHash: voiceHash(host),
  });
  return resolved;
}

/**
 * Guests always resolve fresh — a guest is scoped to one episode, never
 * reused across episodes, so there's no cache to check. Guests always get
 * a bespoke Voice Design voice designed from their English persona and accent.
 *
 * Called once per generation attempt (episode creation or `/regenerate`)
 * from orchestrator.ts, in parallel with script generation — not lazily at
 * stream time — so the resolved id is already persisted on the episode
 * doc's guest entry by the time a listener's first `/stream` request needs
 * it (audio.service.ts's resolveCastVoices just reads it). A `/regenerate`
 * re-running this for a guest that already has a previously-resolved
 * Voice-Design voice mints a fresh one and cleans up the stale one
 * afterward — `deleteVoice` is best-effort, so this is safe even if the
 * stale voice was already deleted by cleanupGuestVoice (e.g. a prior
 * attempt's audio fully finished generating before this regenerate ran).
 */
export async function resolveGuestVoice(
  podcastId: string,
  episodeId: string,
  guest: Person,
): Promise<ResolvedVoice & { origin: "design" }> {
  // A voice with no recorded hash predates hash tracking for guests — i.e. it
  // was designed on the previous (AI Studio) platform, where it isn't ours to
  // delete here and the delete would just fail. Only a voice recorded under
  // a hash (this platform) is cleaned up.
  const staleVoiceId =
    guest.resolvedVoiceOrigin === "design" && guest.resolvedVoiceHash ? guest.resolvedVoiceId : null;

  const r = await designFor(guest, (prompt) => setGuestVoicePrompt(podcastId, episodeId, guest.id, prompt));
  const resolved = { voiceId: r.voiceId, origin: "design" as const };

  await setGuestResolvedVoice(podcastId, episodeId, guest.id, {
    resolvedVoiceId: resolved.voiceId,
    resolvedVoiceOrigin: resolved.origin,
    resolvedVoiceHash: voiceHash(guest),
  });

  if (staleVoiceId) await deleteVoice(staleVoiceId);

  return resolved;
}

/**
 * Deletes a guest's Voice-Design voice once its episode's audio generation
 * finishes — never called for a Library voice (not ours to manage). See
 * audio.service.ts / audioFinalize.service.ts, the callers.
 */
export async function cleanupGuestVoice(guest: Person): Promise<void> {
  if (guest.resolvedVoiceOrigin === "design" && guest.resolvedVoiceId) {
    await deleteVoice(guest.resolvedVoiceId);
  }
}
