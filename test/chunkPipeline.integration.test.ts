import { describe, expect, it } from "vitest";
import { chunkTranscript, sealedChunksSoFar } from "../src/services/episodeGeneration/chunker";
import { buildTranscript, type TranscriptTurn } from "../src/services/episodeGeneration/transcriptBuilder";
import { getChunkText } from "../src/services/audio.service";
import { parseScriptTurns } from "../src/utils/scriptText";

// Reproduces the real orchestrator -> /stream pipeline end to end: turns are
// generated one at a time (as conversationLoop.ts does), chunk boundaries are
// sealed incrementally after each turn (as orchestrator.ts does), and every
// chunk that ends up in the final ttsChunks array is put through the exact
// functions audio.service.ts uses to turn it into TTS input. This is the seam
// a reported bug (a speaker's lines occasionally coming out in the wrong
// voice, then repeated in the right one) would live in if it's real: either
// chunker.ts producing overlapping/duplicate offsets, or getChunkText's
// backward-scan-for-a-label mis-firing and gluing one speaker's lines onto
// another's turn while the correctly-labeled text also survives elsewhere.
function speaker(name: string, sentences: number, index: number): TranscriptTurn {
  const text = Array.from(
    { length: sentences },
    (_, i) => `${name} says thing number ${index}-${i} about the topic at hand.`,
  ).join(" ");
  return { speakerName: name, text };
}

function buildAlternatingTurns(totalTurns: number, sentencesPerTurn: number): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (let i = 0; i < totalTurns; i++) {
    turns.push(speaker(i % 2 === 0 ? "Alice" : "Bob", sentencesPerTurn, i));
  }
  return turns;
}

/** What a fully-correct pipeline should reconstruct: each original turn's speaker+text, in order. */
function expectedPairs(turns: TranscriptTurn[]): { speaker: string; text: string }[] {
  return turns.map((t) => ({ speaker: t.speakerName, text: t.text.trim() }));
}

function actualPairsFromChunks(transcript: string, chunks: ReturnType<typeof chunkTranscript>) {
  const pairs: { speaker: string; text: string }[] = [];
  for (const chunk of chunks) {
    const chunkText = getChunkText(transcript, chunk);
    for (const turn of parseScriptTurns(chunkText)) {
      pairs.push({ speaker: turn.speaker, text: turn.text });
    }
  }
  return pairs;
}

describe("chunker -> getChunkText -> parseScriptTurns pipeline", () => {
  const cases = [
    { totalTurns: 6, sentencesPerTurn: 1, basePromptTokens: 11_900 },
    { totalTurns: 20, sentencesPerTurn: 2, basePromptTokens: 11_800 },
    { totalTurns: 40, sentencesPerTurn: 1, basePromptTokens: 11_950 },
    { totalTurns: 15, sentencesPerTurn: 8, basePromptTokens: 11_950 }, // forces oversized-turn splitting
  ];

  for (const { totalTurns, sentencesPerTurn, basePromptTokens } of cases) {
    it(`reconstructs exactly the original speaker/text pairs for ${totalTurns} turns x ${sentencesPerTurn} sentences`, () => {
      const turns = buildAlternatingTurns(totalTurns, sentencesPerTurn);
      const transcript = buildTranscript(turns);

      const finalChunks = chunkTranscript(transcript, basePromptTokens);

      // No overlaps, and no gap wider than the 2-char "\n\n" separator
      // between turn spans (chunk boundaries exclude that separator, so a
      // 2-char gap between chunks that start a new turn is expected; a
      // gap of 0 is expected between sentence-split sub-chunks of one
      // oversized turn, which share no separator).
      let cursor = 0;
      for (const chunk of finalChunks) {
        expect(chunk.startOffset).toBeGreaterThanOrEqual(cursor);
        expect(chunk.startOffset).toBeLessThanOrEqual(cursor + 2);
        cursor = chunk.endOffset;
      }
      expect(cursor).toBe(transcript.length);

      const actual = actualPairsFromChunks(transcript, finalChunks);
      const expected = expectedPairs(turns);

      // Sentence-split sub-chunks of one oversized turn each parse as their
      // own ScriptTurn with the same (re-attributed) speaker and get folded
      // back together here for comparison against the original single turn.
      const merged: { speaker: string; text: string }[] = [];
      for (const pair of actual) {
        const last = merged[merged.length - 1];
        if (last && last.speaker === pair.speaker && merged.length > 0 && expected.length > merged.length - 1) {
          // Only merge when this really is a continuation (i.e. the previous
          // original turn was split), not a case where two DIFFERENT turns
          // happen to share a speaker consecutively (alternating speakers
          // here means that never happens, so any same-speaker adjacency is
          // necessarily a split continuation).
          last.text = `${last.text} ${pair.text}`.trim();
        } else {
          merged.push({ ...pair });
        }
      }

      expect(merged).toEqual(expected);
    });
  }

  it("attributes lines correctly when a speaker's name has a character outside the label pattern (e.g. an accented guest name)", () => {
    // SPEAKER_LABEL_RE / matchLabelPrefix (scriptText.ts) only recognize
    // "[A-Z][A-Za-z0-9 .'-]{0,59}:" as a turn label. A guest display name is
    // a free-text zod string with no such restriction (person.schema.ts) —
    // if a name like "María" ever reaches here, does getChunkText's
    // backward-scan silently misattribute her lines to the previous
    // speaker instead of failing loudly?
    const turns: TranscriptTurn[] = [
      { speakerName: "Alice", text: "Let's get started with today's guest." },
      { speakerName: "María", text: "Thanks for having me, excited to be here." },
      { speakerName: "Alice", text: "So tell us about your background." },
      { speakerName: "María", text: "Sure, I've been working in this field for years." },
    ];
    const transcript = buildTranscript(turns);
    const basePromptTokens = 11_990; // tiny budget: forces a chunk boundary at every turn

    const finalChunks = chunkTranscript(transcript, basePromptTokens);
    const actual = actualPairsFromChunks(transcript, finalChunks);

    expect(actual).toEqual(expectedPairs(turns));
  });

  it("attributes lines correctly when a speaker's name has a curly apostrophe (a common LLM-generated-name artifact)", () => {
    // wizard.schema.ts's podcastOptionSchema.hosts / episodeDraftSchema.guests
    // are LLM-generated drafts, not just user-typed — an LLM commonly emits a
    // typographic apostrophe (’ "'") by default rather than a plain
    // ASCII "'" in a stylized name like "D'Angelo".
    const turns: TranscriptTurn[] = [
      { speakerName: "Priya", text: "Let's dive into tonight's topic." },
      { speakerName: "D’Angelo", text: "Thanks, happy to be back on the show." },
      { speakerName: "Priya", text: "So what's new with you?" },
      { speakerName: "D’Angelo", text: "Quite a lot, actually, let me explain." },
    ];
    const transcript = buildTranscript(turns);
    const basePromptTokens = 11_990;

    const finalChunks = chunkTranscript(transcript, basePromptTokens);
    const actual = actualPairsFromChunks(transcript, finalChunks);

    expect(actual).toEqual(expectedPairs(turns));
  });

  it("incremental sealing never produces a chunk whose text differs from what the final pass produces for the same offsets", () => {
    const turns = buildAlternatingTurns(30, 2);
    const basePromptTokens = 11_850;

    let transcript = "";
    let previousChunks: ReturnType<typeof chunkTranscript> = [];
    for (const turn of turns) {
      transcript = transcript.length === 0 ? buildTranscript([turn]) : `${transcript}\n\n${buildTranscript([turn])}`;
      const sealed = sealedChunksSoFar(transcript, basePromptTokens);

      for (let i = 0; i < previousChunks.length; i++) {
        const prev = previousChunks[i];
        const now = sealed[i];
        if (!prev) continue;
        expect(now).toEqual(prev);
        // The actual TTS input for an already-sealed chunk must also stay
        // byte-identical once more turns are appended after it.
        expect(getChunkText(transcript, now!)).toBe(getChunkText(transcript, prev));
      }
      previousChunks = sealed;
    }

    const final = chunkTranscript(transcript, basePromptTokens);
    for (let i = 0; i < previousChunks.length; i++) {
      expect(final[i]).toEqual(previousChunks[i]);
    }
  });
});
