import { describe, expect, it } from "vitest";
import {
  consumeScriptStream,
  reattachOrphanedStyle,
  resolveEmptyTurnText,
  validateSpeakerTurns,
} from "../src/services/episodeGeneration/scriptGeneration.service";

// Hand-written fake in place of generatePlainTextStream's real
// AsyncGenerator<string> — consumeScriptStream only depends on that
// interface, so no Gemini client mocking is needed to test it.
async function* fakeStream(...deltas: string[]): AsyncGenerator<string> {
  for (const delta of deltas) yield delta;
}

async function* throwingStream(...deltas: string[]): AsyncGenerator<string> {
  for (const delta of deltas) yield delta;
  throw new Error("stream dropped");
}

describe("validateSpeakerTurns", () => {
  it("accepts turns that only use the two expected labels", () => {
    expect(() =>
      validateSpeakerTurns(
        [
          { speaker: "Maya", text: "Hey." },
          { speaker: "Camille", text: "Hi." },
          { speaker: "Maya", text: "Anyway." },
        ],
        "Maya",
        "Camille",
      ),
    ).not.toThrow();
  });

  it("throws on a label that isn't one of the two expected ones", () => {
    expect(() =>
      validateSpeakerTurns(
        [
          { speaker: "Maya", text: "Hey." },
          { speaker: "Narrator", text: "Once upon a time." },
        ],
        "Maya",
        "Camille",
      ),
    ).toThrow(/unexpected speaker label "Narrator"/);
  });

  it("throws on a full name where only the first name was asked for", () => {
    // The whole point of the exact-format contract: no fuzzy tolerance for
    // "close enough" labels — either the model followed the instruction, or
    // the caller retries the generation.
    expect(() =>
      validateSpeakerTurns(
        [
          { speaker: "Maya Cruz", text: "Hey." },
          { speaker: "Camille", text: "Hi." },
        ],
        "Maya",
        "Camille",
      ),
    ).toThrow(/unexpected speaker label "Maya Cruz"/);
  });

  it("throws if one of the two expected speakers never gets a line", () => {
    expect(() =>
      validateSpeakerTurns(
        [
          { speaker: "Maya", text: "Hey." },
          { speaker: "Maya", text: "Still me." },
        ],
        "Maya",
        "Camille",
      ),
    ).toThrow(/never gives Camille a line/);
  });
});

describe("resolveEmptyTurnText", () => {
  it("leaves a turn with real spoken text unchanged (aside from sanitizing)", () => {
    expect(resolveEmptyTurnText({ speaker: "Maya", text: "  Hey there.  ", style: "cheerful" })).toEqual({
      speaker: "Maya",
      text: "Hey there.",
      style: "cheerful",
    });
  });

  it("turns a bare speaker label with only a Style line into an inline vocal-burst turn", () => {
    // The model's recurring mistake: "Maya:\nStyle: laughs" instead of
    // writing the reaction as spoken content. Rather than dropping the
    // turn, the style becomes the turn's own inline-tagged text.
    expect(resolveEmptyTurnText({ speaker: "Maya", text: "", style: "laughs" })).toEqual({
      speaker: "Maya",
      text: "<laughs>",
    });
  });

  it("treats whitespace-only text the same as fully empty text", () => {
    expect(resolveEmptyTurnText({ speaker: "Maya", text: "   \n  ", style: "sighs" })).toEqual({
      speaker: "Maya",
      text: "<sighs>",
    });
  });

  it("drops the style annotation once it's been folded into the text", () => {
    const result = resolveEmptyTurnText({ speaker: "Maya", text: "", style: "chuckles softly" });
    expect(result.style).toBeUndefined();
  });

  it("returns empty text unchanged when there's no text and no style to fall back on", () => {
    expect(resolveEmptyTurnText({ speaker: "Maya", text: "" })).toEqual({ speaker: "Maya", text: "" });
  });
});

describe("reattachOrphanedStyle", () => {
  it("merges an orphaned Style-only turn into the same-speaker turn right after it", () => {
    // The model's other recurring mistake: splitting a turn's own "Style:"
    // line out into its own empty turn instead of attaching it to the line
    // it actually describes.
    const turns = [
      { speaker: "Chloe", text: "", style: "deadpan" },
      { speaker: "Chloe", text: "Sure, that'll go great." },
    ];
    expect(reattachOrphanedStyle(turns)).toEqual([{ speaker: "Chloe", text: "Sure, that'll go great.", style: "deadpan" }]);
  });

  it("leaves an orphaned Style-only turn alone when the next turn is a different speaker", () => {
    // No real turn to reattach to here — resolveEmptyTurnText's
    // pure-reaction fallback handles this case instead.
    const turns = [
      { speaker: "Chloe", text: "", style: "laughs" },
      { speaker: "Marcus", text: "What's so funny?" },
    ];
    expect(reattachOrphanedStyle(turns)).toEqual(turns);
  });

  it("leaves an orphaned Style-only turn alone when it's the last turn", () => {
    const turns = [{ speaker: "Chloe", text: "", style: "laughs" }];
    expect(reattachOrphanedStyle(turns)).toEqual(turns);
  });

  it("prefers the next turn's own style if it already had one", () => {
    const turns = [
      { speaker: "Chloe", text: "", style: "deadpan" },
      { speaker: "Chloe", text: "Sure.", style: "sarcastic" },
    ];
    expect(reattachOrphanedStyle(turns)).toEqual([{ speaker: "Chloe", text: "Sure.", style: "sarcastic" }]);
  });

  it("leaves turns with real text untouched", () => {
    const turns = [
      { speaker: "Chloe", text: "Hey." },
      { speaker: "Marcus", text: "Hi." },
    ];
    expect(reattachOrphanedStyle(turns)).toEqual(turns);
  });
});

describe("consumeScriptStream", () => {
  it("completes cleanly, reporting canSeal only once both labels have appeared", async () => {
    const progress: boolean[] = [];
    const stream = fakeStream("Maya: Hey there.\n\n", "Camille: Hi Maya.\n\n", "Maya: Great to have you.");
    const result = await consumeScriptStream(stream, [], "Maya", "Camille", false, false, async (p) => {
      progress.push(p.canSeal);
      return false;
    });

    expect(result.error).toBeNull();
    expect(result.seenA).toBe(true);
    expect(result.seenB).toBe(true);
    expect(result.turns).toEqual([
      { speaker: "Maya", text: "Hey there." },
      { speaker: "Camille", text: "Hi Maya." },
      { speaker: "Maya", text: "Great to have you." },
    ]);
    // canSeal only flips to true once Camille's turn is confirmed (the
    // second progress call); it stays true for the final call once the
    // stream ends and the last turn is folded in too.
    expect(progress).toEqual([false, true, true]);
  });

  it("only folds a turn once the next one starts (the last parsed turn may still be growing)", async () => {
    const seen: Array<string[]> = [];
    const stream = fakeStream("Maya: Hey", " there.\n\nCamille: Hi.");
    await consumeScriptStream(stream, [], "Maya", "Camille", false, false, async (p) => {
      seen.push(p.transcript.split("\n\n"));
      return false;
    });
    // "Maya: Hey there." only gets folded in (first progress call) once
    // "Camille: Hi." starts arriving — a single delta that's still mid-turn
    // confirms nothing yet. The second call is the final one, once the
    // stream ends and Camille's turn is folded in too.
    expect(seen).toEqual([["Maya: Hey there."], ["Maya: Hey there.", "Camille: Hi."]]);
  });

  it("stops on an unexpected speaker label, keeping every turn validated before it", async () => {
    const stream = fakeStream("Maya: Hey.\n\n", "Narrator: Once upon a time.\n\n", "Maya: more text here");
    const result = await consumeScriptStream(stream, [], "Maya", "Camille", false, false);

    expect((result.error as Error).message).toMatch(/unexpected speaker label "Narrator"/);
    expect(result.turns).toEqual([{ speaker: "Maya", text: "Hey." }]);
  });

  it("errors if one of the two expected speakers never appears by stream end", async () => {
    const stream = fakeStream("Maya: Hey.\n\n", "Maya: Still me.");
    const result = await consumeScriptStream(stream, [], "Maya", "Camille", false, false);

    expect((result.error as Error).message).toMatch(/never gives Camille a line/);
    expect(result.turns).toEqual([
      { speaker: "Maya", text: "Hey." },
      { speaker: "Maya", text: "Still me." },
    ]);
  });

  it("surfaces a stream-level error while preserving turns validated before it", async () => {
    const stream = throwingStream("Maya: Hey.\n\n", "Camille: Hi.\n\n");
    const result = await consumeScriptStream(stream, [], "Maya", "Camille", false, false);

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("stream dropped");
    expect(result.turns).toEqual([{ speaker: "Maya", text: "Hey." }]);
  });

  it("resumes from seeded priorTurns/seenA/seenB, as a continuation attempt would", async () => {
    const priorTurns = [{ speaker: "Maya", text: "Hey." }];
    const stream = fakeStream("Camille: Hi Maya.");
    const result = await consumeScriptStream(stream, priorTurns, "Maya", "Camille", true, false);

    expect(result.error).toBeNull();
    expect(result.turns).toEqual([
      { speaker: "Maya", text: "Hey." },
      { speaker: "Camille", text: "Hi Maya." },
    ]);
  });
});
