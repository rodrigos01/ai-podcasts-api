export interface TranscriptTurn {
  speakerName: string;
  text: string;
  style?: string;
}

export function buildTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map((turn) => {
      const speakerLine = `${turn.speakerName}: ${turn.text.trim()}`;
      const styleLine = turn.style ? `\nStyle: ${turn.style.trim()}` : "";
      return `${speakerLine}${styleLine}`;
    })
    .join("\n\n");
}
