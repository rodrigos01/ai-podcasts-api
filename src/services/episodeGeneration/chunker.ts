import { TURNS_PER_CHUNK } from "../../constants/ttsLimits";
import { parseScriptTurns, type ScriptTurn, SPEAKER_LABEL_RE } from "../../utils/scriptText";
import type { TtsChunk } from "../../schemas/episode.schema";

export interface TurnSpan {
  turnIndex: number;
  speaker: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Splits a transcript into per-turn spans with exact character offsets
 * in the original transcript string. Multi-paragraph turns (paragraphs
 * not starting with a speaker label) are folded into the preceding turn
 * matching parseScriptTurns's semantics.
 */
export function splitIntoTurnSpans(transcript: string): TurnSpan[] {
  const spans: TurnSpan[] = [];
  let cursor = 0;
  for (const part of transcript.split("\n\n")) {
    const end = cursor + part.length;
    const match = part.match(SPEAKER_LABEL_RE);
    if (match?.[1]) {
      spans.push({
        turnIndex: spans.length,
        speaker: match[1],
        text: part.slice(match[0].length).trim(),
        startOffset: cursor,
        endOffset: end,
      });
    } else if (spans.length > 0) {
      const last = spans[spans.length - 1]!;
      last.text += `\n\n${part.trim()}`;
      last.endOffset = end;
    }
    cursor = end + 2; // account for "\n\n"
  }
  return spans;
}

/**
 * Groups a transcript's script turns into chunks of `turnsPerChunk` (default 10).
 * Offsets are exact slices of the original transcript covering the full turn range.
 */
export function chunkTranscript(
  transcript: string,
  turnsPerChunk: number = TURNS_PER_CHUNK,
): TtsChunk[] {
  const spans = splitIntoTurnSpans(transcript);
  if (spans.length === 0) return [];

  const chunks: TtsChunk[] = [];
  const chunkCount = Math.ceil(spans.length / turnsPerChunk);

  for (let i = 0; i < chunkCount; i++) {
    const startTurnIndex = i * turnsPerChunk;
    const endTurnIndex = Math.min((i + 1) * turnsPerChunk, spans.length);
    const firstSpan = spans[startTurnIndex]!;
    const lastSpan = spans[endTurnIndex - 1]!;

    chunks.push({
      index: i,
      startTurnIndex,
      endTurnIndex,
      startOffset: firstSpan.startOffset,
      endOffset: lastSpan.endOffset,
      turnCount: endTurnIndex - startTurnIndex,
    });
  }

  return chunks;
}

/**
 * Returns the parsed script turns for a specific chunk from the transcript.
 */
export function getChunkTurns(transcript: string, chunk: TtsChunk): ScriptTurn[] {
  return parseScriptTurns(transcript.slice(chunk.startOffset, chunk.endOffset));
}
