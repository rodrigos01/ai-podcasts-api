import { createHash } from "node:crypto";
import { generateText } from "../../llm/geminiClient";
import { deleteVoice, designVoice, findLibraryVoice } from "../../llm/ttsClient";
import { setHostResolvedVoice } from "../../data/podcast.repository";
import { resolveAndPersistGuestVoice } from "../../data/episode.repository";
import type { Person } from "../../schemas/person.schema";
import {
  buildPersonaPrompt,
  guestVoiceLibrarySchema,
  hostVoiceDesignSchema,
  VOICE_DESIGN_SYSTEM_INSTRUCTION,
  VOICE_LIBRARY_SYSTEM_INSTRUCTION,
} from "../../llm/prompts/voiceResolution.prompts";

export interface ResolvedVoice {
  voiceId: string;
  languageCode?: string;
}

/**
 * Detects a stale cached voice — an edit to name/persona/accent/voice hint
 * should trigger a fresh Voice Design call, not silently keep reusing a
 * voice designed for the old text. Same pattern as the investigation
 * spike's own `voiceCacheKey`.
 */
function voiceHash(person: Person): string {
  return createHash("sha256")
    .update(`${person.name}\u0000${person.persona}\u0000${person.accent ?? ""}\u0000${person.voice}`)
    .digest("hex");
}

async function designFor(person: Person): Promise<ResolvedVoice> {
  const req = await generateText({
    systemInstruction: VOICE_DESIGN_SYSTEM_INSTRUCTION,
    prompt: buildPersonaPrompt(person),
    schema: hostVoiceDesignSchema,
  });
  const voiceId = await designVoice({
    displayName: req.displayName,
    languageCode: req.languageCode,
    gender: req.gender,
    voiceDescription: req.voiceDescription,
  });
  return { voiceId, languageCode: req.languageCode };
}

/**
 * Hosts get a bespoke Voice Design voice, persisted on the Podcast document
 * and reused for every future episode — designing one is a real, billed
 * LLM + Voice Design call, so this only happens once per host (until their
 * persona/accent/voice hint actually changes) rather than per episode.
 */
export async function resolveHostVoice(podcastId: string, host: Person): Promise<ResolvedVoice> {
  const hash = voiceHash(host);
  if (host.resolvedVoiceId && host.resolvedVoiceHash === hash) {
    return { voiceId: host.resolvedVoiceId };
  }

  const resolved = await designFor(host);
  await setHostResolvedVoice(podcastId, host.id, {
    resolvedVoiceId: resolved.voiceId,
    resolvedVoiceOrigin: "design",
    resolvedVoiceHash: hash,
  });
  return resolved;
}

/**
 * Guests always resolve fresh — a guest is scoped to one episode, never
 * reused across episodes, so there's no cache to check. Routes through
 * Voice Design (not the Library) when the guest has a stated accent: the
 * Library's accent taxonomy only models regional variation *within* a
 * language, with no way to express "a native speaker of one language
 * carrying an accent while speaking another" (confirmed in the
 * investigation). Deduplicated across concurrent first-time
 * listeners/instances by `episode.repository.ts`'s
 * `resolveAndPersistGuestVoice`, which also handles cleaning up a losing
 * concurrent Voice-Design mint.
 */
export async function resolveGuestVoice(
  podcastId: string,
  episodeId: string,
  guest: Person,
): Promise<ResolvedVoice & { origin: "design" | "library" }> {
  // Captured from whichever resolve attempt actually ran here — if another
  // concurrent caller won the race (resolveAndPersistGuestVoice below),
  // this is still this call's own attempt's language, not necessarily the
  // winner's; a harmless inconsistency in that rare case, since only the
  // actual generation leader's own resolution feeds a real synthesis call.
  let languageCode: string | undefined;

  const resolve = guest.accent
    ? async () => {
        const r = await designFor(guest);
        languageCode = r.languageCode;
        return { voiceId: r.voiceId, origin: "design" as const };
      }
    : async () => {
        const req = await generateText({
          systemInstruction: VOICE_LIBRARY_SYSTEM_INSTRUCTION,
          prompt: buildPersonaPrompt(guest),
          schema: guestVoiceLibrarySchema,
        });
        languageCode = req.languageCode;
        const match = await findLibraryVoice({
          languageCode: req.languageCode,
          gender: req.gender,
          pitch: req.pitch,
          accent: req.accent,
          personaKeywords: req.personaKeywords,
          contexts: req.contexts,
          search: req.search,
        });
        return { voiceId: match.voiceId, origin: "library" as const };
      };

  const outcome = await resolveAndPersistGuestVoice(podcastId, episodeId, guest.id, resolve, deleteVoice);
  return { voiceId: outcome.voiceId, origin: outcome.origin, languageCode };
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
