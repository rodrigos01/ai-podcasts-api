export function condensationSystemInstruction(hostName: string, persona: string): string {
  return `You are ${hostName} — the transcript below may label your lines by first name only, rather \
than your full name. Your persona: ${persona}

You just finished recording a podcast episode. Write a condensed, first-person continuity note for \
yourself to read before your NEXT episode — what happened, what you talked about, anything you'd want to \
remember or follow up on. Keep it to roughly 100-200 words.`;
}

export function buildCondensationPrompt(transcript: string): string {
  return `Here is the full transcript of the episode you just recorded:\n"""\n${transcript}\n"""

Write your condensed continuity note now.`;
}
