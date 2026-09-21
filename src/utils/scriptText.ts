// A turn label is a plain "Name:" at the very start of a line — no
// brackets. Brackets are reserved for inline delivery tags (e.g.
// [whispers]), which can appear anywhere in a turn's text, including right
// at the start — so a label has to be visually/structurally distinct from
// those, not just "bracketed text". The captured name must come out
// byte-for-byte identical to whatever identifies that speaker in the voice
// config (a Person's `name` / a SpeakerVoice's `speaker`), since that's
// what the TTS call matches against — see geminiClient.ts's streamSpeech.
//
// The name is required to start with a capital letter and stay within a
// name-shaped character set (letters/digits/space/'.-) — this is what
// keeps an incidental colon in ordinary prose ("Note: ...", "3:00 came and
// went") from being mistaken for a label, now that brackets no longer mark
// the boundary for us. This must match what hostPersona.prompts.ts's
// transcript-building and sceneDirector.prompts.ts's format instruction
// actually produce — if you change the turn format, update this too.
const NAME_PATTERN = "[A-Z][A-Za-z0-9 .'-]{0,59}";
export const SPEAKER_LABEL_RE = new RegExp(`^(${NAME_PATTERN}):`);
const SPEAKER_LABEL_GLOBAL_RE = new RegExp(`^(${NAME_PATTERN}):`, "gm");

/**
 * Every distinct speaker labeled in a "Name: text" formatted script, in
 * order of first appearance. Used to figure out which characters actually
 * speak in a given scene's generated script, without re-deriving it from
 * the draft's cast list (a script may use fewer characters than the scene
 * was originally expected to feature).
 */
export function extractSpeakerNames(script: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const turn of script.split("\n\n")) {
    const name = turn.match(SPEAKER_LABEL_RE)?.[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** The "Name:" prefix (including trailing whitespace) at the very start of `text`, if any. */
export function matchLabelPrefix(text: string): string | null {
  const match = text.match(new RegExp(`^${NAME_PATTERN}:\\s*`));
  return match ? match[0] : null;
}

/**
 * The most recent turn label (e.g. "Marcus:") appearing anywhere in
 * `precedingText`, if any — used to re-attribute a chunk that's a
 * continuation of an oversized turn and so doesn't start with its own
 * label. Anchored to line starts (not a bare substring search), since
 * without brackets a plain "Name:" pattern is only unambiguous at the
 * position turns are actually formatted to start from.
 */
export function findLastSpeakerLabel(precedingText: string): string | null {
  const matches = [...precedingText.matchAll(SPEAKER_LABEL_GLOBAL_RE)];
  const last = matches.at(-1);
  return last ? last[0] : null;
}

export interface ScriptTurn {
  speaker: string;
  text: string;
}

/**
 * Parses a "Name: text" formatted script/chunk into structured turns for
 * the Cloud Text-to-Speech `multiSpeakerMarkup.turns` field — shared by
 * both the Podcast and Audiobook audio services. The chunk text passed in
 * is expected to already start with a label (callers' own getChunkText
 * ensures this, backward-scanning for one if a chunk is a continuation of
 * an oversized turn); a paragraph with no label of its own is folded into
 * the previous turn's text rather than dropped or misattributed, since a
 * single turn's own text can itself contain internal blank-line breaks.
 */
export function parseScriptTurns(script: string): ScriptTurn[] {
  const turns: ScriptTurn[] = [];
  const re = new RegExp(`^(${NAME_PATTERN}):\\s*([\\s\\S]*)$`);
  for (const part of script.split("\n\n")) {
    const match = part.match(re);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      turns.push({ speaker: match[1], text: match[2].trim() });
    } else if (turns.length > 0) {
      const last = turns[turns.length - 1];
      if (last) last.text += `\n\n${part.trim()}`;
    }
  }
  return turns;
}
