import { describe, expect, it } from "vitest";
import { normalizeSpeakerTurns } from "../src/services/episodeGeneration/scriptGeneration.service";
import type { Speaker } from "../src/services/episodeGeneration/speakerSelection";

function speaker(name: string, isHost = true): Speaker {
  return { id: name.toLowerCase(), name, voice: "Puck", persona: "p", isHost };
}

describe("normalizeSpeakerTurns", () => {
  const maya = speaker("Maya Cruz");
  const camille = speaker("Camille Laurent", false);
  const speakers: [Speaker, Speaker] = [maya, camille];

  it("keeps an already-exact label unchanged", () => {
    const result = normalizeSpeakerTurns(
      [
        { speaker: "Maya Cruz", text: "Hey." },
        { speaker: "Camille Laurent", text: "Hi." },
      ],
      speakers,
    );
    expect(result).toEqual([
      { speaker: "Maya Cruz", text: "Hey." },
      { speaker: "Camille Laurent", text: "Hi." },
    ]);
  });

  it("normalizes a case-insensitive exact match to the canonical casing", () => {
    const result = normalizeSpeakerTurns(
      [
        { speaker: "maya cruz", text: "Hey." },
        { speaker: "Camille Laurent", text: "Hi." },
      ],
      speakers,
    );
    expect(result[0]?.speaker).toBe("Maya Cruz");
  });

  it("normalizes an abbreviated first-name label (the label-drift finding)", () => {
    // Regression case from the single-LLM experiment: stricter word-count
    // prompting drifted full names ("Maya Cruz") down to first names only
    // ("Maya") — chunker.ts/geminiClient.ts key off the exact full name, so
    // this has to be resolved back to the canonical form.
    const result = normalizeSpeakerTurns(
      [
        { speaker: "Maya", text: "Hey." },
        { speaker: "Camille", text: "Hi." },
      ],
      speakers,
    );
    expect(result).toEqual([
      { speaker: "Maya Cruz", text: "Hey." },
      { speaker: "Camille Laurent", text: "Hi." },
    ]);
  });

  it("throws on a label that matches neither speaker", () => {
    expect(() =>
      normalizeSpeakerTurns(
        [
          { speaker: "Narrator", text: "Once upon a time." },
          { speaker: "Camille Laurent", text: "Hi." },
        ],
        speakers,
      ),
    ).toThrow(/Could not match speaker label/);
  });

  it("throws on a label that ambiguously matches more than one speaker's first name", () => {
    const ambiguousSpeakers: [Speaker, Speaker] = [speaker("Cam Rivera"), speaker("Cam Chen", false)];
    expect(() =>
      normalizeSpeakerTurns(
        [
          { speaker: "Cam", text: "Hey." },
          { speaker: "Cam Chen", text: "Hi." },
        ],
        ambiguousSpeakers,
      ),
    ).toThrow(/Could not match speaker label/);
  });

  it("throws if one of the two cast members never gets a line", () => {
    expect(() =>
      normalizeSpeakerTurns(
        [
          { speaker: "Maya Cruz", text: "Hey." },
          { speaker: "Maya Cruz", text: "Still me." },
        ],
        speakers,
      ),
    ).toThrow(/never gives Camille Laurent a line/);
  });
});
