import { z } from "zod";

// Voice Design builds a voice from a natural-language description. Confirmed
// by ear against the live API: the best input is the speaker's bio, in
// English (a voice designed from an English prompt still speaks any language,
// with the intended accent), plus an explicit accent statement when there is
// one — stating the accent is far more effective than leaving it to be
// inferred from the bio's origin story. The name goes first because a bio
// doesn't always make the speaker's gender clear and the name does. That is
// all we send; no LLM rewrite step sits in between. Called by
// services/episodeGeneration/voiceResolution.service.ts.

export function buildVoiceDesignInput(name: string, personaEn: string, accentEn?: string): string {
  const lines = [`Name: ${name}`, personaEn];
  if (accentEn) lines.push(`Accent: ${accentEn}`);
  return lines.join("\n\n");
}

// Fallback for people who have no English persona/accent stored (created
// before those fields existed, or by a client that didn't send them): one
// small call produces them, so such a person gets the same voice-design
// input a freshly wizard-written one has.
export const englishVoiceInputSchema = z.object({
  personaEn: z.string().min(1),
  accentEn: z.string().min(1).optional(),
});

export const ENGLISH_VOICE_INPUT_SYSTEM_INSTRUCTION =
  "You prepare a podcast speaker's description for a text-to-speech voice-design system that " +
  "works best from English text. Given the speaker's persona (and optionally a stated accent), " +
  "which may be in any language, return the persona translated into English, keeping every " +
  "detail that bears on how the person would sound (age, background, origin, temperament) and " +
  "adding nothing; and, only if an accent was stated, that accent described in plain English " +
  "(e.g. 'Northern Irish', 'light French accent when speaking Portuguese'). If the text is " +
  "already in English, return it unchanged. Never invent an accent that wasn't stated.";

export function buildEnglishVoiceInputPrompt(persona: string, accent?: string): string {
  const lines = [`Persona:\n${persona}`];
  if (accent) lines.push(`Stated accent: ${accent}`);
  return lines.join("\n\n");
}
