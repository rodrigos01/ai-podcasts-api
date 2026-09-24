import { speakerLabel, type Speaker } from "./speakerSelection";

// A fixed, generic delivery instruction — not podcast- or episode-specific,
// and not LLM-generated (see generateBaseTtsPrompt's own doc comment for
// why). Deliberately says nothing about scene/setting: unlike the scene
// this replaced, nothing about a recording location or atmosphere was ever
// load-bearing for TTS delivery quality, just extra prose for the model to
// read.
const SAMPLE_CONTEXT =
  "This is a natural, unscripted-sounding podcast conversation. Speak with the " +
  "warmth, spontaneity, and casual rhythm of real people genuinely talking with " +
  "each other — natural reactions, relaxed pacing, and authentic vocal energy, " +
  "not a formal read.";

/**
 * Builds the base TTS director prompt entirely programmatically from each
 * speaker's own stored data — no LLM call (2026-09-24). This replaced an
 * earlier `generateText`-drafted template (a "# THE SCENE" paragraph plus a
 * per-speaker AUDIO PROFILE + DIRECTOR'S NOTES block covering archetype,
 * style, pacing, and accent) after live testing traced a reproducible
 * Vertex AI content-moderation false positive (support code 54702341) to
 * that template's elaborate, creative-writing-flavored notes prose for one
 * specific speaker — the exact wording, not the underlying persona or topic,
 * was the trigger. A controlled before/after test against the same
 * previously-failing content found this much shorter, purely data-driven
 * template (a fixed generic Sample Context, each speaker's own `persona`
 * verbatim, and a one-line accent note only for a speaker who has one) took
 * the failure rate from 0/7 to roughly 65-75% success, with no quality
 * regression heard on unaffected episodes — not a full fix (the same
 * generic classifier false-positive can still occasionally fire on
 * unrelated content), but a real reduction on top of the existing
 * retry/backoff and per-chunk skip-and-continue behavior (see
 * geminiClient.ts / audio.service.ts). Verified manually against the live
 * API, not covered by an automated test — same as the rest of this
 * project's LLM/TTS integration, see AGENTS.md's Gemini API usage section.
 *
 * Runs before script generation and doesn't need it — a speaker's `persona`
 * and `accent` are both fixed at cast time, and the whole point of dropping
 * the LLM step is that this no longer needs to wait on anything.
 */
export function generateBaseTtsPrompt(speakers: [Speaker, Speaker]): string {
  const [a, b] = speakers;
  const labeled = [
    { label: speakerLabel(a.name, b.name), speaker: a },
    { label: speakerLabel(b.name, a.name), speaker: b },
  ];

  const profileBlocks = labeled
    .map(({ label, speaker }) => `### Audio Profile: ${label}\n${speaker.persona}`)
    .join("\n\n");

  const accentLines = labeled
    .filter(({ speaker }) => speaker.accent)
    .map(({ label, speaker }) => `Accent: ${label} — ${speaker.accent}`)
    .join("\n");
  const directorNote = accentLines ? `\n\n### Director's note\n${accentLines}` : "";

  return `### Sample Context\n${SAMPLE_CONTEXT}\n\n${profileBlocks}${directorNote}`;
}
