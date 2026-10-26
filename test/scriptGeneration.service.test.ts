import { describe, expect, it } from "vitest";
import {
  attachTrailingStyle,
  validateTurnTags,
  reattachOrphanedStyle,
  resolveEmptyTurnText,
  validateSpeakerTurns,
} from "../src/services/episodeGeneration/scriptGeneration.service";

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

describe("attachTrailingStyle", () => {
  it("attaches a labelled style-only turn to the same speaker's turn before it", () => {
    const turns = [
      { speaker: "Penny", text: "That is wild!" },
      { speaker: "Penny", text: "", style: "warm, curious" },
      { speaker: "Mateo", text: "Right?" },
    ];
    expect(attachTrailingStyle(turns)).toEqual([
      { speaker: "Penny", text: "That is wild!", style: "warm, curious" },
      { speaker: "Mateo", text: "Right?" },
    ]);
  });

  it("leaves a style-only turn alone when the turn before it is someone else's or already styled", () => {
    const otherSpeaker = [{ speaker: "Mateo", text: "Right?" }, { speaker: "Penny", text: "", style: "warm" }];
    expect(attachTrailingStyle(otherSpeaker)).toEqual(otherSpeaker);
    const alreadyStyled = [{ speaker: "Penny", text: "Hi", style: "bright" }, { speaker: "Penny", text: "", style: "warm" }];
    expect(attachTrailingStyle(alreadyStyled)).toEqual(alreadyStyled);
  });
});

describe("validateTurnTags", () => {
  it("accepts short sound and action tags", () => {
    expect(() => validateTurnTags([{ speaker: "Penny", text: "<laughs> Oh no. <covers face with hands> Really?" }])).not.toThrow();
  });

  it("rejects a tag that holds a delivery direction and the whole spoken line", () => {
    const text = "<softly That is actually very sweet. The airport snack photo is the universal badge of the first-time traveler.>";
    expect(() => validateTurnTags([{ speaker: "Mateo", text }])).toThrow(/spoken words inside an angle-bracket tag/);
  });
});
