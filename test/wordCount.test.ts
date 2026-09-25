import { describe, expect, it } from "vitest";
import { countWords } from "../src/utils/wordCount";

describe("countWords", () => {
  it("counts plain words", () => {
    expect(countWords("the quick brown fox")).toBe(4);
  });

  it("excludes bracketed audio tags", () => {
    expect(countWords("[whispers] the quick [very fast] brown fox")).toBe(4);
  });

  it("excludes turn comments, style lines, and angle bracket vocal tags", () => {
    const text = `// Turn 1
Maya: Look at that! <laughter>
Style: whispering

// Turn 2
Camille: I saw it too. <gasp>`;
    // Maya(1) Look(2) at(3) that(4) Camille(5) I(6) saw(7) it(8) too(9) = 9 words
    expect(countWords(text)).toBe(9);
  });

  it("handles contractions and punctuation as single words", () => {
    expect(countWords("I don't think that's right, honestly.")).toBe(6);
  });

  it("returns 0 for empty or tag-only input", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("[sighs] [pause]")).toBe(0);
    expect(countWords("// Turn 1\nStyle: sarcastic\n<laughter>")).toBe(0);
  });
});
