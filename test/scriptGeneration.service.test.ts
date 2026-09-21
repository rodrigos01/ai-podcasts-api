import { describe, expect, it } from "vitest";
import { validateSpeakerTurns } from "../src/services/episodeGeneration/scriptGeneration.service";

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
