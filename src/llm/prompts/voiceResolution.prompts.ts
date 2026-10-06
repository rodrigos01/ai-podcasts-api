// Voice Design builds a voice from a natural-language description. The prompt
// is the speaker's name (first, because a bio doesn't always make their gender
// clear), their persona as written, and an explicit accent line when there is
// one — stating the accent is far more effective than leaving it to be inferred
// from the bio. The podcast's language goes to the Voices API as its own
// `language_code` (see ttsClient.ts's designVoice), which is what lets the
// persona and accent stay in the show's own language with no translation step.
// Used by utils/voicePrompt.ts.

export function buildVoiceDesignInput(name: string, persona: string, accent?: string): string {
  const lines = [`Name: ${name}`, persona];
  if (accent) lines.push(`Accent: ${accent}`);
  return lines.join("\n\n");
}
