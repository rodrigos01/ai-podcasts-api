import { z } from "zod";
import type { Person } from "../../schemas/person.schema";

// Adapted from the investigation spike's HOST_SYSTEM_INSTRUCTION/
// GUEST_SYSTEM_INSTRUCTION (scripts/test-gemini-3.8-tts.ts on
// claude/gemini-3.8-flash-tts-test-cphacd) — confirmed live against the
// real Voice Design/Library APIs. Called by
// services/episodeGeneration/voiceResolution.service.ts.

export function buildPersonaPrompt(person: Person): string {
  const lines = [`Name: ${person.name}`, `Persona:\n${person.persona}`, `Voice hint: ${person.voice}`];
  if (person.accent) lines.push(`Stated accent: ${person.accent}`);
  return lines.join("\n\n");
}

export const hostVoiceDesignSchema = z.object({
  languageCode: z.string().min(2).max(10),
  languageName: z.string().min(1),
  gender: z.enum(["male", "female", "neutral"]),
  voiceDescription: z.string().min(30),
  displayName: z.string().min(1).max(60),
});
export type HostVoiceDesignRequest = z.infer<typeof hostVoiceDesignSchema>;

// Used for hosts always, and for a guest whose persona implies an accent
// (see voiceResolution.service.ts) — the Voice Library's accent taxonomy
// only models regional variation *within* a language (e.g. regional
// American English), with no way to express "a native speaker of one
// language carrying an accent while speaking another," which is exactly
// what those personas call for (confirmed in the investigation).
export const VOICE_DESIGN_SYSTEM_INSTRUCTION =
  "You are casting a bespoke synthetic voice for a podcast speaker using a text-to-speech " +
  "'voice design' system that builds a brand-new voice purely from a natural-language " +
  "description of how it sounds (age, timbre, pacing, energy, gender presentation, and — " +
  "when relevant — a spoken accent). That system never reads the description aloud, so it " +
  "must describe only the VOICE, never the speaker's name, biography, opinions, or topics. " +
  "The speaker's name and their own free-text voice hint are given below only as signals — " +
  "the name for perceived gender presentation (most first names strongly imply one; fall " +
  "back to the persona's own phrasing when a name is ambiguous or gender-neutral), and the " +
  "voice hint for the tone/character to design toward, though you should still write your " +
  "own complete, vivid description rather than repeating it verbatim.\n\n" +
  "First, work out what natural language the persona text below is itself written in — that " +
  "is the language this speaker will actually speak on the show — and report it as a BCP-47 " +
  "tag (e.g. 'en-US', 'es-ES', 'pt-BR', 'fr-FR', 'ja-JP'), preferring a specific regional tag " +
  "the text's diction suggests, otherwise a common default for that language.\n\n" +
  "Then write a vivid, 2-4 sentence voice-design description, plus a perceived gender " +
  "presentation and a short display name for this voice. If the persona describes the " +
  "speaker as being from a place, culture, or background distinct from that language's home " +
  "region — e.g. a native speaker of one language or region speaking a different one on the " +
  "show — explicitly describe the resulting accent in the voice-design text (e.g. 'a warm " +
  "male voice speaking Portuguese with a noticeable Peruvian Spanish accent'), rather than " +
  "describing a neutral/native accent by default.";

export const guestVoiceLibrarySchema = z.object({
  languageCode: z.string().min(2).max(10),
  languageName: z.string().min(1),
  gender: z.enum(["male", "female", "neutral"]),
  pitch: z.enum(["low", "medium", "high"]).optional(),
  accent: z.string().min(1).optional(),
  personaKeywords: z.array(z.string().min(1)).min(1).max(3),
  contexts: z.array(z.string().min(1)).min(1).max(2),
  search: z.string().min(1).optional(),
});
export type GuestVoiceLibraryRequest = z.infer<typeof guestVoiceLibrarySchema>;

export const VOICE_LIBRARY_SYSTEM_INSTRUCTION =
  "You are selecting a stock voice for a podcast guest from a text-to-speech voice library, " +
  "by proposing filters for a ListVoices-style query: perceived gender, pitch, one to three " +
  "persona/archetype keywords (e.g. 'Warm, Friendly' or 'Narrator'), one or two usage-context " +
  "keywords (e.g. 'Conversational', 'News'), an optional accent descriptor, and an optional " +
  "free-text search string. The guest's name and their own free-text voice hint are given " +
  "below only as signals — the name for perceived gender presentation (most first names " +
  "strongly imply one; fall back to the persona's own phrasing when a name is ambiguous or " +
  "gender-neutral), and the voice hint for the tone/character to search for.\n\n" +
  "First, work out what natural language the persona text below is itself written in — that " +
  "is the language this guest will actually speak — and report it as a BCP-47 tag (e.g. " +
  "'en-US', 'es-ES', 'pt-BR', 'fr-FR', 'ja-JP').\n\n" +
  "Then propose filter values most likely to surface a fitting available voice for this guest.";
