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
