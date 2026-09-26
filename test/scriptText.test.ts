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

  it("matches a label containing an accented/non-ASCII letter", () => {
    // Regression test: a plain [A-Za-z] character class stops matching at
    // the first non-ASCII letter, so "Chloé:" would fail to match at all —
    // the whole line then gets folded into the previous turn as an
    // unlabeled continuation instead of recognized as Chloé's own turn,
    // which surfaced as "the generated script never gives Chloé Moreau a
    // line" even though her lines were genuinely present in the script.
    expect(SPEAKER_LABEL_RE.test("Chloé: Bonjour!")).toBe(true);
    expect(extractSpeakerNames("Chloé: Hey.\n\nMarcus: Hi.")).toEqual(["Chloé", "Marcus"]);
  });

  it("extracts speaker names from scripts with // Turn comments and Style: lines", () => {
    const script = `// Turn 1
Marcus: Hello.
Style: whispering

// Turn 2
Priya: Hi there.`;

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

  it("parses // Turn comments and extracts Style: line", () => {
    const script = `// Turn 1
Marcus: Hey there everyone!
Style: energetic, cheerful

// Turn 2
Priya: Welcome back.

// Turn 3
Marcus: Let's get right into it.
Style: focused`;

    expect(parseScriptTurns(script)).toEqual([
      { speaker: "Marcus", text: "Hey there everyone!", style: "energetic, cheerful" },
      { speaker: "Priya", text: "Welcome back." },
      { speaker: "Marcus", text: "Let's get right into it.", style: "focused" },
    ]);
  });

  it("parses turns without comments, extracting Style: and preserving cues and pipes", () => {
    const script = `Carlos: Mira esto <risas> |totalmente| no lo puedo creer.
Style: susurrando

Sofia: Es impresionante.`;

    expect(parseScriptTurns(script)).toEqual([
      {
        speaker: "Carlos",
        text: "Mira esto <risas> |totalmente| no lo puedo creer.",
        style: "susurrando",
      },
      {
        speaker: "Sofia",
        text: "Es impresionante.",
      },
    ]);
  });

  it("parses a turn labeled with an accented/non-ASCII name", () => {
    const script = "Chloé: Bonjour!\n\nMarcus: Hey.";
    expect(parseScriptTurns(script)).toEqual([
      { speaker: "Chloé", text: "Bonjour!" },
      { speaker: "Marcus", text: "Hey." },
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
