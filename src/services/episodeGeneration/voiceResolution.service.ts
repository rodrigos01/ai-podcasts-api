import { designVoice } from "../../llm/ttsClient";
import { deleteVoicesIfUnused } from "../voiceCleanup.service";
import { setHostResolvedVoice, setHostVoicePrompt } from "../../data/podcast.repository";
import { getEpisode, setGuestResolvedVoice, setGuestVoicePrompt } from "../../data/episode.repository";
import type { Episode } from "../../schemas/episode.schema";
import type { Person } from "../../schemas/person.schema";
import { hasCurrentVoice, voiceHash } from "../../utils/voiceHash";
import { withVoicePrompt } from "../../utils/voicePrompt";

export { hasCurrentVoice };

export interface ResolvedVoice {
  voiceId: string;
}

/**
 * Designs from the person's stored Voice Design prompt. A person without one
 * (saved before prompts were stored) gets it written first — and persisted via
 * `persist` before the design call, so a failed attempt doesn't lose it.
 */
async function designFor(
  person: Person,
  persist: (voicePrompt: string) => Promise<void>,
  languageCode?: string,
): Promise<ResolvedVoice> {
  let voicePrompt = person.voicePrompt;
  if (!voicePrompt) {
    voicePrompt = withVoicePrompt(person).voicePrompt;
    await persist(voicePrompt);
  }
  const voiceId = await designVoice({ voiceDescription: voicePrompt, ...(languageCode ? { languageCode } : {}) });
  return { voiceId };
}

/**
 * Hosts get a bespoke Voice Design voice, persisted on the Podcast document
 * and reused for every future episode — designing one is a real, billed
 * LLM + Voice Design call, so this only happens once per host (until their
 * persona/accent/voice hint actually changes) rather than per episode.
 */
export async function resolveHostVoice(
  podcastId: string,
  host: Person,
  languageCode?: string,
): Promise<ResolvedVoice> {
  if (hasCurrentVoice(host)) {
    return { voiceId: host.resolvedVoiceId };
  }

  const resolved = await designFor(host, (prompt) => setHostVoicePrompt(podcastId, host.id, prompt), languageCode);
  await setHostResolvedVoice(podcastId, host.id, {
    resolvedVoiceId: resolved.voiceId,
    resolvedVoiceOrigin: "design",
    resolvedVoiceHash: voiceHash(host),
  });
  return resolved;
}

/**
 * Designs voices for hosts a save left without one (see voiceDecision.ts's
 * needsVoiceNow), in the background of that save so the next generation finds
 * them ready. Best-effort: a failure is logged and the host's voice is simply
 * designed at the next generation, as before.
 */
export async function designHostVoicesNow(podcastId: string, hosts: Person[], languageCode?: string): Promise<void> {
  const results = await Promise.allSettled(hosts.map((host) => resolveHostVoice(podcastId, host, languageCode)));
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`Could not design a voice for host ${hosts[i]?.id} after a save (will retry at generation):`, result.reason);
    }
  });
}

/**
 * Guests always resolve fresh — a guest is scoped to one episode, never
 * reused across episodes, so there's no cache to check. Guests always get
 * a bespoke Voice Design voice designed from their persona and accent.
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
  languageCode?: string,
  earlierPartGuests: Person[] = [],
): Promise<ResolvedVoice & { origin: "design" }> {
  // A voice the user picked is kept for every generation, never re-designed.
  if (guest.resolvedVoicePinned && guest.resolvedVoiceId) {
    return { voiceId: guest.resolvedVoiceId, origin: "design" };
  }

  // The same guest in the part before this one (a multi-episode suggestion repeats its guest in
  // every part) keeps that voice, so a listener doesn't hear one person in two voices.
  const sharedVoiceId = sharedGuestVoiceId(guest, earlierPartGuests);

  // A voice with no recorded hash predates hash tracking for guests — i.e. it
  // was designed on the previous (AI Studio) platform, where it isn't ours to
  // delete here and the delete would just fail. Only a voice recorded under
  // a hash (this platform) is cleaned up.
  const staleVoiceId =
    guest.resolvedVoiceOrigin === "design" && guest.resolvedVoiceHash ? guest.resolvedVoiceId : null;

  if (sharedVoiceId) {
    await setGuestResolvedVoice(podcastId, episodeId, guest.id, {
      resolvedVoiceId: sharedVoiceId,
      resolvedVoiceOrigin: "design",
      resolvedVoiceHash: voiceHash(guest),
    });
    if (staleVoiceId && staleVoiceId !== sharedVoiceId) await deleteVoicesIfUnused([staleVoiceId]);
    return { voiceId: sharedVoiceId, origin: "design" };
  }

  const r = await designFor(guest, (prompt) => setGuestVoicePrompt(podcastId, episodeId, guest.id, prompt), languageCode);
  const resolved = { voiceId: r.voiceId, origin: "design" as const };

  await setGuestResolvedVoice(podcastId, episodeId, guest.id, {
    resolvedVoiceId: resolved.voiceId,
    resolvedVoiceOrigin: resolved.origin,
    resolvedVoiceHash: voiceHash(guest),
  });

  if (staleVoiceId) await deleteVoicesIfUnused([staleVoiceId]);

  return resolved;
}

/**
 * The guests of the part this episode follows in a multi-episode suggestion (none for any other
 * episode), for `resolveGuestVoice` to share voices with.
 */
export async function earlierPartGuests(podcastId: string, episode: Pick<Episode, "startsAfterEpisodeId">): Promise<Person[]> {
  if (!episode.startsAfterEpisodeId) return [];
  return (await getEpisode(podcastId, episode.startsAfterEpisodeId))?.guests ?? [];
}

/** The voice of the earlier part's guest that is this same person (same name/persona/accent/hint), if it has a usable one. */
function sharedGuestVoiceId(guest: Person, earlierGuests: Person[]): string | null {
  const hash = voiceHash(guest);
  const same = earlierGuests.find((earlier) => hasCurrentVoice(earlier) && voiceHash(earlier) === hash);
  return same?.resolvedVoiceId ?? null;
}

/**
 * Deletes a guest's Voice-Design voice once its episode's audio generation
 * finishes — never called for a Library voice (not ours to manage). See
 * audio.service.ts / audioFinalize.service.ts, the callers.
 */
export async function cleanupGuestVoice(guest: Person): Promise<void> {
  // A picked voice lives as long as its episode (deleted with it).
  if (guest.resolvedVoicePinned) return;
  if (guest.resolvedVoiceOrigin === "design" && guest.resolvedVoiceId) {
    await deleteVoicesIfUnused([guest.resolvedVoiceId]);
  }
}
