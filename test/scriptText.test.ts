import { describe, expect, it } from "vitest";
import {
  extractSpeakerNames,
  findLastSpeakerLabel,
  matchLabelPrefix,
  parseScriptTurns,
  SPEAKER_LABEL_RE,
} from "../src/utils/scriptText";

describe("SPEAKER_LABEL_RE / extractSpeakerNames", () => {
  it("matches a plain 'Name:' label with no brackets", () => {
    expect(SPEAKER_LABEL_RE.test("Marcus: Hey there.")).toBe(true);
  });

  it("does not mistake a leading delivery tag for a label", () => {
    // Delivery tags stay bracketed and never have a colon right after them,
    // so this must not match — a real turn always starts with the plain name.
    expect(SPEAKER_LABEL_RE.test("[whispers] Marcus leans in.")).toBe(false);
  });

  it("does not mistake an incidental colon in ordinary prose for a label", () => {
    expect(SPEAKER_LABEL_RE.test("note: this is not a speaker")).toBe(false);
    expect(SPEAKER_LABEL_RE.test("3:00 came and went")).toBe(false);
  });

  it("extracts every distinct speaker in order of first appearance", () => {
    const script = "Marcus: Hey.\n\nPriya: Hi.\n\nMarcus: Again.";
    expect(extractSpeakerNames(script)).toEqual(["Marcus", "Priya"]);
  });
});

describe("parseScriptTurns", () => {
  it("parses multiple plain-name turns into structured {speaker, text}", () => {
    const script = "Marcus: Hey there.\n\nPriya: Oh, hi!";
    expect(parseScriptTurns(script)).toEqual([
      { speaker: "Marcus", text: "Hey there." },
      { speaker: "Priya", text: "Oh, hi!" },
    ]);
  });

  it("preserves inline delivery tags within a turn's own text", () => {
    const script = "Marcus: [whispers] Hey there.";
    expect(parseScriptTurns(script)).toEqual([{ speaker: "Marcus", text: "[whispers] Hey there." }]);
  });

  it("folds an unlabeled continuation paragraph into the previous turn", () => {
    const script = "Marcus: First part.\n\nStill part of the same turn.\n\nPriya: Reply.";
    expect(parseScriptTurns(script)).toEqual([
      { speaker: "Marcus", text: "First part.\n\nStill part of the same turn." },
      { speaker: "Priya", text: "Reply." },
    ]);
  });
});

describe("matchLabelPrefix", () => {
  it("returns the 'Name: ' prefix when present", () => {
    expect(matchLabelPrefix("Marcus: hello")).toBe("Marcus: ");
  });

  it("returns null when there is no label", () => {
    expect(matchLabelPrefix("just some text")).toBeNull();
  });
});

describe("findLastSpeakerLabel", () => {
  it("finds the most recent label across multiple turns", () => {
    const text = "Marcus: First.\n\nPriya: Second.\n\n";
    expect(findLastSpeakerLabel(text)).toBe("Priya:");
  });

  it("ignores incidental colons that aren't at a line start", () => {
    const text = "Marcus: He said the time was 3:00 sharp.\n\n";
    expect(findLastSpeakerLabel(text)).toBe("Marcus:");
  });

  it("returns null when no label appears", () => {
    expect(findLastSpeakerLabel("no labels here at all")).toBeNull();
  });
});
