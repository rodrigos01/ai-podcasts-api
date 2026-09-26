import { MAX_WORDS_PER_CHUNK, TURNS_PER_CHUNK } from "../../constants/ttsLimits";
import { parseScriptTurns, type ScriptTurn, SPEAKER_LABEL_RE } from "../../utils/scriptText";
import { countWords } from "../../utils/wordCount";
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
    const parsed = parseScriptTurns(part);
    if (parsed.length > 0 && parsed[0]) {
      const turn = parsed[0];
      spans.push({
        turnIndex: spans.length,
        speaker: turn.speaker,
        text: turn.text,
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

function makeChunk(index: number, spans: TurnSpan[], startTurnIndex: number, endTurnIndex: number): TtsChunk {
  const firstSpan = spans[startTurnIndex]!;
  const lastSpan = spans[endTurnIndex - 1]!;
  return {
    index,
    startTurnIndex,
    endTurnIndex,
    startOffset: firstSpan.startOffset,
    endOffset: lastSpan.endOffset,
    turnCount: endTurnIndex - startTurnIndex,
  };
}

/**
 * Groups a transcript's script turns into chunks bounded by `turnsPerChunk`
 * (default 10) turns *or* `maxWordsPerChunk` (default 650) words, whichever
 * is reached first — see ttsLimits.ts's MAX_WORDS_PER_CHUNK for why turn
 * count alone doesn't bound a chunk's audio duration under Gemini's ~300s
 * hard synthesis limit. A single turn whose own text exceeds the word cap
 * still gets its own chunk (it can't be split without breaking the
 * "Name: text" structure) — the chunk is only ever cut short before a turn
 * that isn't the chunk's first. Offsets are exact slices of the original
 * transcript covering the full turn range.
 */
export function chunkTranscript(
  transcript: string,
  turnsPerChunk: number = TURNS_PER_CHUNK,
  maxWordsPerChunk: number = MAX_WORDS_PER_CHUNK,
): TtsChunk[] {
  const spans = splitIntoTurnSpans(transcript);
  if (spans.length === 0) return [];

  const chunks: TtsChunk[] = [];
  let chunkStart = 0;
  let chunkWords = 0;

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const spanWords = countWords(span.text);
    const turnsSoFar = i - chunkStart;

    if (chunkStart < i && (turnsSoFar >= turnsPerChunk || chunkWords + spanWords > maxWordsPerChunk)) {
      chunks.push(makeChunk(chunks.length, spans, chunkStart, i));
      chunkStart = i;
      chunkWords = 0;
    }

    chunkWords += spanWords;
  }

  chunks.push(makeChunk(chunks.length, spans, chunkStart, spans.length));
  return chunks;
}

/**
 * Returns the parsed script turns for a specific chunk from the transcript.
 */
export function getChunkTurns(transcript: string, chunk: TtsChunk): ScriptTurn[] {
  return parseScriptTurns(transcript.slice(chunk.startOffset, chunk.endOffset));
}
