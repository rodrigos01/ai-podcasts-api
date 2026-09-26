import { MAX_WORDS_PER_CHUNK, TURNS_PER_CHUNK } from "../../constants/ttsLimits";
import { findLastSpeakerLabel, parseScriptTurns, type ScriptTurn, SPEAKER_LABEL_RE } from "../../utils/scriptText";
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

// Right after sentence-ending punctuation (plus any trailing closing quote/
// bracket) — a preferred cut point when splitting an oversized turn, since
// it doesn't interrupt a sentence mid-thought the way a plain word-boundary
// cut would.
const SENTENCE_END_RE = /[.!?]+["'”’)\]]*$/;

/**
 * Splits `text` (a single oversized turn's raw "Name: text" slice, or any
 * plain run of words) into consecutive pieces — relative end-offsets into
 * `text`, the last always equal to `text.length` — none exceeding `maxWords`
 * words (per `countWords`), cutting only at whitespace between words. Prefers
 * the most recent sentence-ending boundary within the current piece when a
 * cut is needed; falls back to a plain word boundary if no sentence ending
 * fell inside this piece (e.g. one long run-on sentence with no punctuation
 * for hundreds of words — rare, but a hard word cap still needs a cut
 * somewhere rather than let one piece grow unbounded).
 */
function splitTextByWordBudget(text: string, maxWords: number): number[] {
  const words = [...text.matchAll(/\S+/g)];
  if (words.length === 0) return [text.length];

  const cuts: number[] = [];
  let groupStart = 0;
  let lastSentenceEnd = -1;

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (SENTENCE_END_RE.test(word[0])) lastSentenceEnd = i;

    const from = words[groupStart]!.index!;
    const to = word.index! + word[0].length;
    if (i > groupStart && countWords(text.slice(from, to)) > maxWords) {
      const cutWordIndex = lastSentenceEnd > groupStart ? lastSentenceEnd : i - 1;
      const cutOffset = words[cutWordIndex]!.index! + words[cutWordIndex]![0].length;
      cuts.push(cutOffset);
      groupStart = cutWordIndex + 1;
      lastSentenceEnd = -1;
      i = groupStart - 1; // re-evaluate any words between the cut and here against the new group
    }
  }

  cuts.push(text.length);
  return cuts;
}

/**
 * Splits one oversized turn (whose own word count alone exceeds
 * `maxWords`) into several same-speaker chunks — we already know the
 * speaker (`span.speaker`), so unlike a genuinely ambiguous mid-transcript
 * cut, there's no attribution to guess at. Operates on the turn's raw
 * transcript slice (including its "Name:"/"Style:"/comment header lines,
 * for the first piece only) rather than its already-cleaned `text`, so the
 * returned offsets need no remapping back into `transcript`'s own
 * coordinates — the tradeoff is that `countWords` sees a few extra
 * non-spoken tokens (the label itself) in the first piece's count, which
 * only ever makes that one piece's estimate slightly conservative, never
 * short of the real limit.
 */
function splitOversizedSpan(
  transcript: string,
  span: TurnSpan,
  maxWords: number,
): Array<{ startOffset: number; endOffset: number }> {
  const raw = transcript.slice(span.startOffset, span.endOffset);
  const relativeCuts = splitTextByWordBudget(raw, maxWords);
  const pieces: Array<{ startOffset: number; endOffset: number }> = [];
  let pieceStart = 0;
  for (const cut of relativeCuts) {
    pieces.push({ startOffset: span.startOffset + pieceStart, endOffset: span.startOffset + cut });
    pieceStart = cut;
  }
  return pieces;
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
 * is split into several same-speaker continuation chunks instead of one
 * oversized chunk (see splitOversizedSpan) — we already know the speaker,
 * so there's no ambiguity to resolve the way a truly freeform cut would
 * have. Those continuation chunks' offsets fall inside the turn's own
 * range rather than at a turn boundary; getChunkTurns re-attributes them
 * to the same speaker. Offsets are otherwise exact slices of the original
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

    if (spanWords > maxWordsPerChunk) {
      // This one turn alone busts the cap. Close out whatever chunk was
      // pending, split this turn into several continuation pieces, then
      // start the next chunk fresh after it.
      if (chunkStart < i) {
        chunks.push(makeChunk(chunks.length, spans, chunkStart, i));
      }
      for (const { startOffset, endOffset } of splitOversizedSpan(transcript, span, maxWordsPerChunk)) {
        chunks.push({
          index: chunks.length,
          startTurnIndex: i,
          endTurnIndex: i + 1,
          startOffset,
          endOffset,
          turnCount: 1,
        });
      }
      chunkStart = i + 1;
      chunkWords = 0;
      continue;
    }

    const turnsSoFar = i - chunkStart;
    if (chunkStart < i && (turnsSoFar >= turnsPerChunk || chunkWords + spanWords > maxWordsPerChunk)) {
      chunks.push(makeChunk(chunks.length, spans, chunkStart, i));
      chunkStart = i;
      chunkWords = 0;
    }

    chunkWords += spanWords;
  }

  if (chunkStart < spans.length) {
    chunks.push(makeChunk(chunks.length, spans, chunkStart, spans.length));
  }
  return chunks;
}

/**
 * Returns the parsed script turns for a specific chunk from the transcript.
 * Most chunks start at a turn boundary and parse normally. A chunk that's a
 * continuation piece of an oversized turn (see splitOversizedSpan) starts
 * mid-text with no "Name:" label of its own, so parseScriptTurns finds
 * nothing — in that case, the raw slice is spoken text for whichever
 * speaker's label most recently appeared before it in the transcript
 * (unambiguous: no other turn's label can appear between the original
 * label and a cut point inside its own turn).
 */
export function getChunkTurns(transcript: string, chunk: TtsChunk): ScriptTurn[] {
  const raw = transcript.slice(chunk.startOffset, chunk.endOffset);
  const parsed = parseScriptTurns(raw);
  if (parsed.length > 0) return parsed;

  const label = findLastSpeakerLabel(transcript.slice(0, chunk.startOffset));
  if (!label) return [];
  return [{ speaker: label.slice(0, -1), text: raw.trim() }];
}
