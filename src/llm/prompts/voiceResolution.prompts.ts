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

// Produces the English persona/accent for a person whose own record doesn't
// carry them: the server runs this when it saves a person (see
// services/personEnglish.service.ts) rather than trusting the client to echo
// what the wizard wrote, and again on demand for people saved before that.
// The accent can only come from what the person's text actually says — the
// stated-accent field, or an explicit mention in the voice hint or persona —
// since the wizards often describe an accent in the voice hint and leave the
// accent field itself empty.
export const englishVoiceInputSchema = z.object({
  personaEn: z.string().min(1),
  accentEn: z.string().min(1).optional(),
});

export const ENGLISH_VOICE_INPUT_SYSTEM_INSTRUCTION =
  "You prepare a podcast speaker's description for a text-to-speech voice-design system that " +
  "works best from English text. You are given the speaker's persona, a short voice hint, and " +
  "optionally a stated accent, any of which may be in any language. Return:\n" +
  "- personaEn: the persona translated into English, keeping every detail that bears on how " +
  "the person would sound (age, gender, background, origin, temperament) and adding nothing. " +
  "If it is already in English, return it unchanged.\n" +
  "- accentEn: ONLY if an accent is stated — in the stated-accent field, or explicitly in the " +
  "voice hint or persona (e.g. 'sotaque britânico', 'cadência porteña') — that accent described " +
  "in plain English, including the language it is spoken in when that matters (e.g. 'British " +
  "accent when speaking Portuguese', 'Northern Irish'). Do not infer an accent from where " +
  "someone is from alone, and leave accentEn out entirely when none is stated.";

export function buildEnglishVoiceInputPrompt(persona: string, voice: string, accent?: string): string {
  const lines = [`Persona:\n${persona}`, `Voice hint: ${voice}`];
  if (accent) lines.push(`Stated accent: ${accent}`);
  return lines.join("\n\n");
}
