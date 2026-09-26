import { describe, expect, it } from "vitest";
import { chunkTranscript, getChunkTurns, splitIntoTurnSpans } from "../src/services/episodeGeneration/chunker";
import { parseScriptTurns } from "../src/utils/scriptText";

function createTurn(speaker: string, line: string): string {
  return `${speaker}: ${line}`;
}

describe("chunker", () => {
  it("returns empty chunks for an empty transcript", () => {
    expect(chunkTranscript("")).toEqual([]);
    expect(splitIntoTurnSpans("")).toEqual([]);
  });

  it("creates a single chunk when turn count is <= turnsPerChunk", () => {
    const turns = [
      createTurn("Alice", "Hello there"),
      createTurn("Bob", "Hi Alice"),
      createTurn("Alice", "How are you?"),
    ];
    const transcript = turns.join("\n\n");
    const chunks = chunkTranscript(transcript, 10);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      index: 0,
      startTurnIndex: 0,
      endTurnIndex: 3,
      startOffset: 0,
      endOffset: transcript.length,
      turnCount: 3,
    });

    const parsedTurns = getChunkTurns(transcript, chunks[0]!);
    expect(parsedTurns).toHaveLength(3);
    expect(parsedTurns[0]?.speaker).toBe("Alice");
    expect(parsedTurns[1]?.speaker).toBe("Bob");
    expect(parsedTurns[2]?.speaker).toBe("Alice");
  });

  it("splits transcript into chunks of exactly 10 turns", () => {
    const turns: string[] = [];
    for (let i = 0; i < 25; i++) {
      const speaker = i % 2 === 0 ? "Alice" : "Bob";
      turns.push(createTurn(speaker, `Line number ${i + 1}`));
    }
    const transcript = turns.join("\n\n");
    const chunks = chunkTranscript(transcript, 10);

    expect(chunks).toHaveLength(3);

    // Chunk 0: turns 0..9 (10 turns)
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[0]?.startTurnIndex).toBe(0);
    expect(chunks[0]?.endTurnIndex).toBe(10);
    expect(chunks[0]?.turnCount).toBe(10);
    expect(getChunkTurns(transcript, chunks[0]!)).toHaveLength(10);

    // Chunk 1: turns 10..19 (10 turns)
    expect(chunks[1]?.index).toBe(1);
    expect(chunks[1]?.startTurnIndex).toBe(10);
    expect(chunks[1]?.endTurnIndex).toBe(20);
    expect(chunks[1]?.turnCount).toBe(10);
    expect(getChunkTurns(transcript, chunks[1]!)).toHaveLength(10);

    // Chunk 2: turns 20..24 (5 turns)
    expect(chunks[2]?.index).toBe(2);
    expect(chunks[2]?.startTurnIndex).toBe(20);
    expect(chunks[2]?.endTurnIndex).toBe(25);
    expect(chunks[2]?.turnCount).toBe(5);
    expect(getChunkTurns(transcript, chunks[2]!)).toHaveLength(5);
  });

  it("correctly slices non-Latin/accented character names", () => {
    const turns = [
      createTurn("Chloé", "Bonjour!"),
      createTurn("René", "Comment ça va?"),
      createTurn("Chloé", "Très bien, merci!"),
    ];
    const transcript = turns.join("\n\n");
    const chunks = chunkTranscript(transcript, 2);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.turnCount).toBe(2);
    expect(chunks[1]?.turnCount).toBe(1);

    const chunk0Turns = getChunkTurns(transcript, chunks[0]!);
    expect(chunk0Turns[0]?.speaker).toBe("Chloé");
    expect(chunk0Turns[1]?.speaker).toBe("René");

    const chunk1Turns = getChunkTurns(transcript, chunks[1]!);
    expect(chunk1Turns[0]?.speaker).toBe("Chloé");
  });

  it("handles multi-paragraph turns without miscounting turns", () => {
    const transcript = [
      "Alice: Paragraph one.\n\nParagraph two continuation.",
      "Bob: Response here.",
    ].join("\n\n");

    const spans = splitIntoTurnSpans(transcript);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.speaker).toBe("Alice");
    expect(spans[0]?.text).toContain("Paragraph two continuation");
    expect(spans[1]?.speaker).toBe("Bob");

    const chunks = chunkTranscript(transcript, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.turnCount).toBe(2);

    const turns = getChunkTurns(transcript, chunks[0]!);
    expect(turns).toEqual(parseScriptTurns(transcript));
  });

  it("chunks transcripts with // Turn comments and Style: lines preserving styles", () => {
    const transcript = [
      "// Turn 1\nAlice: Opening line.\nStyle: energetic",
      "// Turn 2\nBob: Great to be here.",
      "// Turn 3\nAlice: Final thoughts.\nStyle: whispering",
    ].join("\n\n");

    const chunks = chunkTranscript(transcript, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.turnCount).toBe(2);
    expect(chunks[1]?.turnCount).toBe(1);

    const chunk0Turns = getChunkTurns(transcript, chunks[0]!);
    expect(chunk0Turns).toEqual([
      { speaker: "Alice", text: "Opening line.", style: "energetic" },
      { speaker: "Bob", text: "Great to be here." },
    ]);

    const chunk1Turns = getChunkTurns(transcript, chunks[1]!);
    expect(chunk1Turns).toEqual([
      { speaker: "Alice", text: "Final thoughts.", style: "whispering" },
    ]);
  });

  it("cuts a chunk short on word count even when under the turn limit", () => {
    const longLine = Array(60).fill("word").join(" "); // 60 words per turn
    const turns = [
      createTurn("Alice", longLine), // 60
      createTurn("Bob", longLine), // 120
      createTurn("Alice", longLine), // 180
      createTurn("Bob", longLine), // 240 -- adding the 5th (300) still <= maxWords
      createTurn("Alice", longLine), // 300
      createTurn("Bob", longLine), // would be 360, over a 300-word cap
    ];
    const transcript = turns.join("\n\n");
    const chunks = chunkTranscript(transcript, 10, 300);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.turnCount).toBe(5);
    expect(chunks[1]?.turnCount).toBe(1);
    expect(chunks[1]?.startTurnIndex).toBe(5);
  });

  it("splits an over-limit single turn into same-speaker continuation chunks, at sentence boundaries", () => {
    const bobLine = "One two three four five. Six seven eight nine ten. Eleven twelve thirteen fourteen fifteen.";
    const turns = [createTurn("Alice", "hi"), createTurn("Bob", bobLine), createTurn("Alice", "bye")];
    const transcript = turns.join("\n\n");
    const chunks = chunkTranscript(transcript, 10, 8);

    // Alice/hi, 3 Bob pieces (sentence 1, sentence 2, sentence 3), Alice/bye.
    expect(chunks).toHaveLength(5);
    expect(chunks[0]?.turnCount).toBe(1);
    expect(chunks[4]?.turnCount).toBe(1);

    for (const chunk of chunks.slice(1, 4)) {
      expect(chunk?.turnCount).toBe(1);
      expect(chunk?.startTurnIndex).toBe(1);
      expect(chunk?.endTurnIndex).toBe(2);
    }

    const pieces = chunks.slice(1, 4).map((c) => getChunkTurns(transcript, c!));
    expect(pieces.every((p) => p.length === 1 && p[0]?.speaker === "Bob")).toBe(true);
    expect(pieces.map((p) => p[0]?.text)).toEqual([
      "One two three four five.",
      "Six seven eight nine ten.",
      "Eleven twelve thirteen fourteen fifteen.",
    ]);

    expect(getChunkTurns(transcript, chunks[0]!)[0]).toMatchObject({ speaker: "Alice", text: "hi" });
    expect(getChunkTurns(transcript, chunks[4]!)[0]).toMatchObject({ speaker: "Alice", text: "bye" });
  });

  it("falls back to a plain word-boundary cut for a run-on turn with no sentence punctuation", () => {
    const hugeLine = Array(400).fill("word").join(" "); // no periods anywhere -- no sentence boundaries to prefer
    const turns = [createTurn("Alice", "short line"), createTurn("Bob", hugeLine), createTurn("Alice", "short line")];
    const transcript = turns.join("\n\n");
    const chunks = chunkTranscript(transcript, 10, 300);

    expect(chunks[0]?.turnCount).toBe(1);
    expect(chunks[chunks.length - 1]?.turnCount).toBe(1);

    const bobChunks = chunks.slice(1, -1);
    expect(bobChunks.length).toBeGreaterThan(1); // the 400-word turn had to be split
    for (const chunk of bobChunks) {
      expect(chunk?.startTurnIndex).toBe(1);
      expect(chunk?.endTurnIndex).toBe(2);
    }

    const bobPieces = bobChunks.map((c) => getChunkTurns(transcript, c!));
    expect(bobPieces.every((p) => p.length === 1 && p[0]?.speaker === "Bob")).toBe(true);
    // Every piece (after the label-bearing first one) stays within the cap,
    // and the pieces reassemble the original 400-word line exactly.
    const reassembled = bobPieces.map((p) => p[0]!.text).join(" ");
    expect(reassembled).toBe(hugeLine);
  });

  it("still respects the turn-count limit when word count stays low", () => {
    const turns: string[] = [];
    for (let i = 0; i < 12; i++) {
      turns.push(createTurn(i % 2 === 0 ? "Alice" : "Bob", "ok"));
    }
    const transcript = turns.join("\n\n");
    const chunks = chunkTranscript(transcript, 10, 650);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.turnCount).toBe(10);
    expect(chunks[1]?.turnCount).toBe(2);
  });

  it("chunks transcripts without comments with styles and backchannel pipes", () => {
    const transcript = [
      "Alice: Opening line |yeah| right here.\nStyle: energetic",
      "Bob: Great to be here <laughter>.",
      "Alice: Final thoughts.\nStyle: whispering",
    ].join("\n\n");

    const chunks = chunkTranscript(transcript, 2);
    expect(chunks).toHaveLength(2);

    const chunk0Turns = getChunkTurns(transcript, chunks[0]!);
    expect(chunk0Turns).toEqual([
      { speaker: "Alice", text: "Opening line |yeah| right here.", style: "energetic" },
      { speaker: "Bob", text: "Great to be here <laughter>." },
    ]);
  });
});
