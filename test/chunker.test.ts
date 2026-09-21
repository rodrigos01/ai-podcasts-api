import { describe, expect, it } from "vitest";
import { chunkTranscript } from "../src/services/episodeGeneration/chunker";

const MAX_TTS_INPUT_TOKENS = 12_000;

function turn(speaker: string, chars: number): string {
  return `${speaker}: ${"a".repeat(chars)}`;
}

describe("chunkTranscript", () => {
  it("combines multiple small turns into one chunk when well under budget", () => {
    const transcript = [turn("A", 40), turn("B", 40), turn("A", 40)].join("\n\n");
    const chunks = chunkTranscript(transcript, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startOffset).toBe(0);
    expect(chunks[0]?.endOffset).toBe(transcript.length);
  });

  it("never splits a turn across two chunks", () => {
    // budget ~= 100 tokens (~400 chars) after basePromptTokens is subtracted.
    const basePromptTokens = MAX_TTS_INPUT_TOKENS - 100;
    const turns = [turn("A", 300), turn("B", 300), turn("A", 300)];
    const transcript = turns.join("\n\n");
    const chunks = chunkTranscript(transcript, basePromptTokens);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const slice = transcript.slice(chunk.startOffset, chunk.endOffset);
      // Every chunk boundary should land on a "Speaker:" turn start, never mid-turn.
      expect(slice.startsWith("A:") || slice.startsWith("B:")).toBe(true);
    }
  });

  it("respects the token budget net of the base prompt's token cost", () => {
    const basePromptTokens = MAX_TTS_INPUT_TOKENS - 100;
    const transcript = [turn("A", 300), turn("B", 300)].join("\n\n");
    const chunks = chunkTranscript(transcript, basePromptTokens);
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(100);
    }
  });

  it("falls back to sentence-level splitting for a single oversized turn", () => {
    const basePromptTokens = MAX_TTS_INPUT_TOKENS - 100; // budget ~400 chars
    const longSentence = "This is a sentence that repeats. ".repeat(40); // ~1360 chars, one turn
    const labeledTranscript = `A: ${longSentence}`;
    const chunks = chunkTranscript(labeledTranscript, basePromptTokens);

    expect(chunks.length).toBeGreaterThan(1);
    // Only the first sub-chunk carries the original "A:" label — offsets
    // stay pure slices of the original transcript; a consumer re-adds the
    // label for later sub-chunks by scanning backward for it (see chunker.ts).
    const firstSlice = labeledTranscript.slice(chunks[0]?.startOffset, chunks[0]?.endOffset);
    expect(firstSlice.startsWith("A:")).toBe(true);

    // Chunks are contiguous, non-overlapping slices covering the whole turn.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.startOffset).toBe(chunks[i - 1]?.endOffset);
    }
    expect(chunks[0]?.startOffset).toBe(0);
    expect(chunks[chunks.length - 1]?.endOffset).toBe(labeledTranscript.length);

    const rebuilt = chunks.map((c) => labeledTranscript.slice(c.startOffset, c.endOffset)).join("");
    expect(rebuilt).toBe(labeledTranscript);
  });
});
