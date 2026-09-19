import { MAX_TTS_INPUT_TOKENS, TARGET_CHUNK_TOKENS } from "../../constants/ttsLimits";
import { estimateTokens } from "../../utils/tokenEstimate";
import { matchLabelPrefix } from "../../utils/scriptText";
import type { TtsChunk } from "../../schemas/episode.schema";

interface TurnSpan {
  text: string;
  startOffset: number;
  endOffset: number;
}

function splitIntoTurnSpans(transcript: string): TurnSpan[] {
  const spans: TurnSpan[] = [];
  let cursor = 0;
  // Turns are separated by the blank line transcriptBuilder joins them with.
  for (const part of transcript.split("\n\n")) {
    spans.push({ text: part, startOffset: cursor, endOffset: cursor + part.length });
    cursor += part.length + 2; // account for the "\n\n" separator
  }
  return spans;
}

// Fallback for a single turn that alone exceeds the per-chunk budget: split
// at sentence boundaries. Offsets stay pure slices of the *original*
// transcript (never a reconstructed/re-prefixed string) so the "offsets are
// sliced from transcript on demand" contract holds for every chunk — but
// only the first resulting sub-chunk will start with the "Name:" label.
// Consumers (the audio-generation step) must prepend the label themselves
// for later sub-chunks, found by scanning backward from startOffset for
// the nearest "Name:" marker in the full transcript.
function splitOversizedTurn(span: TurnSpan, budgetTokens: number): TurnSpan[] {
  const labelChars = matchLabelPrefix(span.text)?.length ?? 0;
  const sentences = span.text.match(/[^.!?]+[.!?]*\s*/g) ?? [span.text];
  const maxBufferChars = Math.max(1, budgetTokens * 4 - labelChars);

  const parts: TurnSpan[] = [];
  let cursor = span.startOffset;
  let buffer = "";
  for (const sentence of sentences) {
    if (buffer.length > 0 && buffer.length + sentence.length > maxBufferChars) {
      parts.push({ text: buffer, startOffset: cursor, endOffset: cursor + buffer.length });
      cursor += buffer.length;
      buffer = "";
    }
    buffer += sentence;
  }
  if (buffer.length > 0 || parts.length === 0) {
    parts.push({ text: buffer, startOffset: cursor, endOffset: cursor + buffer.length });
  }
  return parts;
}

export function chunkTranscript(transcript: string, basePromptTokens: number): TtsChunk[] {
  const hardCeiling = MAX_TTS_INPUT_TOKENS - basePromptTokens;
  if (hardCeiling <= 0) {
    throw new Error("Base TTS prompt alone exceeds the token budget");
  }
  const budget = Math.min(hardCeiling, TARGET_CHUNK_TOKENS);

  const turnSpans = splitIntoTurnSpans(transcript);
  const chunks: TtsChunk[] = [];
  let currentText = "";
  let currentStart: number | null = null;
  let currentEnd = 0;

  function flush() {
    if (currentStart === null || currentText.trim().length === 0) return;
    chunks.push({
      index: chunks.length,
      startOffset: currentStart,
      endOffset: currentEnd,
      estimatedTokens: estimateTokens(currentText),
    });
    currentText = "";
    currentStart = null;
  }

  for (const span of turnSpans) {
    const spanTokens = estimateTokens(span.text);

    if (spanTokens > budget) {
      // A single turn alone busts the budget — flush what we have, then
      // emit sentence-level sub-chunks for this turn on their own.
      flush();
      for (const sub of splitOversizedTurn(span, budget)) {
        currentText = sub.text;
        currentStart = sub.startOffset;
        currentEnd = sub.endOffset;
        flush();
      }
      continue;
    }

    const candidateText = currentStart === null ? span.text : `${currentText}\n\n${span.text}`;
    const candidateTokens = estimateTokens(candidateText);

    if (candidateTokens > budget) {
      flush();
      currentText = span.text;
      currentStart = span.startOffset;
      currentEnd = span.endOffset;
    } else {
      currentText = candidateText;
      currentStart = currentStart ?? span.startOffset;
      currentEnd = span.endOffset;
    }
  }
  flush();

  return chunks;
}

/**
 * Re-chunks the transcript-so-far during generation, for callers that want
 * to seal chunk boundaries incrementally instead of waiting for the whole
 * conversation to finish. chunkTranscript's left-to-right greedy pass never
 * revisits an earlier flush once it happens, so re-running it against a
 * longer transcript always reproduces identical boundaries for every chunk
 * except the last — that one is still "open" and may grow (or later split)
 * as more turns are appended. Dropping it here means every chunk this
 * returns is final and safe to hand to /stream immediately; the true last
 * chunk only appears once the caller re-chunks with the finished transcript
 * (a plain chunkTranscript call, once the conversation has actually ended).
 */
export function sealedChunksSoFar(transcript: string, basePromptTokens: number): TtsChunk[] {
  return chunkTranscript(transcript, basePromptTokens).slice(0, -1);
}
