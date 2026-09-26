// Strips comments, delivery styles, bracketed audio tags (e.g. "[whispers]"),
// and angle-bracket vocal tags (e.g. "<chuckle>", "<short pause>") before
// counting, since those are delivery cues, not spoken content.
export function countWords(text: string): number {
  const withoutCues = text
    .replace(/\/\/.*$/gm, " ")
    .replace(/^[ \t]*Style:.*$/gmi, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/<[^>]*>/g, " ");
  const words = withoutCues.trim().match(/\S+/g);
  return words ? words.length : 0;
}
