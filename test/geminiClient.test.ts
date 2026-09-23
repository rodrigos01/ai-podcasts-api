import { describe, expect, it } from "vitest";
import { soloSpeakerVoiceName } from "../src/llm/geminiClient";
import type { ScriptTurn } from "../src/utils/scriptText";

const aliasByName = new Map([
  ["Marcus", "Puck"],
  ["Ray", "Kore"],
]);

describe("soloSpeakerVoiceName", () => {
  it("returns the aliased voice name when every turn shares one speaker", () => {
    const turns: ScriptTurn[] = [
      { speaker: "Marcus", text: "First part of the monologue." },
      { speaker: "Marcus", text: "Continuation after an oversized-turn split." },
    ];
    expect(soloSpeakerVoiceName(turns, aliasByName)).toBe("Puck");
  });

  it("returns null for a genuine two-speaker chunk", () => {
    const turns: ScriptTurn[] = [
      { speaker: "Marcus", text: "Hey Ray." },
      { speaker: "Ray", text: "Hey Marcus." },
    ];
    expect(soloSpeakerVoiceName(turns, aliasByName)).toBeNull();
  });

  it("returns null for an empty chunk", () => {
    expect(soloSpeakerVoiceName([], aliasByName)).toBeNull();
  });

  it("falls back to a sanitized alias for a speaker missing from the cast map", () => {
    const turns: ScriptTurn[] = [{ speaker: "Dr. Emily Chen", text: "..." }];
    expect(soloSpeakerVoiceName(turns, aliasByName)).toBe("DrEmilyChen");
  });
});
