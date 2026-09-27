// A turn label is a plain "Name:" at the very start of a line — no
// brackets. Brackets are reserved for inline delivery tags (e.g.
// [whispers]), which can appear anywhere in a turn's text, including right
// at the start — so a label has to be visually/structurally distinct from
// those, not just "bracketed text". The captured name must come out
// byte-for-byte identical to whatever identifies that speaker in the voice
// config (a Person's `name` / a SpeakerVoice's `speaker`), since that's
// what the TTS call matches against — see geminiClient.ts's streamSpeech.
//
// The name is required to start with an uppercase letter and stay within a
// name-shaped character set (letters/marks/digits/space/'.-) — this is what
// keeps an incidental colon in ordinary prose ("Note: ...", "3:00 came and
// went") from being mistaken for a label, now that brackets no longer mark
// the boundary for us. Uses Unicode property escapes (\p{Lu}, \p{L}, \p{M})
// rather than [A-Z]/[A-Za-z] — a plain ASCII class silently broke on any
// accented name (e.g. "Chloé Moreau"): the match stopped dead at "é",
// found no ":" immediately after, and failed the whole label match, so
// that speaker's lines got folded into the previous turn's text as an
// unlabeled continuation instead of recognized as their own turn — which
// then surfaced downstream as "the generated script never gives Chloé
// Moreau a line" (scriptGeneration.service.ts's validateSpeakerTurns),
// a confusing symptom of this regex bug, not of the model actually
// dropping her. \p{M} (combining marks) is included alongside \p{L} in
// case a name arrives NFD-decomposed (base letter + separate combining
// accent) rather than NFC-precomposed. Every RegExp built from this
// pattern needs the "u" flag for the \p{} escapes to work at all. This
// must match what scriptGeneration.prompts.ts's transcript-building and
// sceneDirector.prompts.ts's format instruction actually produce — if you
// change the turn format, update this too.
const NAME_PATTERN = "\\p{Lu}[\\p{L}\\p{M}0-9 .'-]{0,59}";
export const SPEAKER_LABEL_RE = new RegExp(`^(${NAME_PATTERN}):`, "u");
const SPEAKER_LABEL_GLOBAL_RE = new RegExp(`^(${NAME_PATTERN}):`, "gmu");

/**
 * Every distinct speaker labeled in a formatted script, in
 * order of first appearance.
 */
export function extractSpeakerNames(script: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const turns = parseScriptTurns(script);
  for (const turn of turns) {
    if (!seen.has(turn.speaker)) {
      seen.add(turn.speaker);
      names.push(turn.speaker);
    }
  }
  return names;
}

/** The "Name:" prefix (including trailing whitespace) at the very start of `text`, if any. */
export function matchLabelPrefix(text: string): string | null {
  const match = text.match(new RegExp(`^${NAME_PATTERN}:\\s*`, "u"));
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
  style?: string;
}

/**
 * Parses turns separated by "\n\n", extracting speaker name, spoken text,
 * and optional turn delivery style.
 *
 * Supports turns formatted as:
 * // Turn 1
 * Speaker: Text
 * Style: optional short delivery style
 *
 * as well as plain "Speaker: Text" turns.
 */
export function parseScriptTurns(script: string): ScriptTurn[] {
  const turns: ScriptTurn[] = [];
  const speakerRe = new RegExp(`^(${NAME_PATTERN}):\\s*(.*)$`, "u");
  const styleRe = /^Style:\s*(.*)$/i;

  for (const part of script.split("\n\n")) {
    const trimmedPart = part.trim();
    if (!trimmedPart) continue;

    const lines = trimmedPart.split("\n");
    let speaker: string | null = null;
    let style: string | undefined;
    const textLines: string[] = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith("//")) {
        // Comment line like "// Turn 1"
        continue;
      }
      const styleMatch = trimmedLine.match(styleRe);
      if (styleMatch) {
        style = styleMatch[1]!.trim();
        continue;
      }
      if (!speaker) {
        const speakerMatch = trimmedLine.match(speakerRe);
        if (speakerMatch) {
          speaker = speakerMatch[1]!;
          if (speakerMatch[2]) {
            textLines.push(speakerMatch[2].trim());
          }
          continue;
        }
      }
      textLines.push(trimmedLine);
    }

    if (speaker) {
      turns.push({
        speaker,
        text: textLines.join("\n").trim(),
        ...(style ? { style } : {}),
      });
    } else if (turns.length > 0) {
      const last = turns[turns.length - 1]!;
      const cont = textLines.join("\n").trim();
      if (cont) {
        last.text += `\n\n${cont}`;
      }
    }
  }
  return turns;
}
