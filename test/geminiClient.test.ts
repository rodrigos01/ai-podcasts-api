import { describe, expect, it } from "vitest";
import { isModerationRejectionError, soloSpeakerVoiceName } from "../src/llm/geminiClient";
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

function grpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("isModerationRejectionError", () => {
  it("matches the real INVALID_ARGUMENT usage-guidelines rejection", () => {
    const err = grpcError(
      3,
      "3 INVALID_ARGUMENT: Cloud Text-to-Speech could not generate audio because the input text or prompt violates Vertex AI's usage guidelines. If you think this was an error, send feedback. Support codes: 54702341",
    );
    expect(isModerationRejectionError(err)).toBe(true);
  });

  it("does not match a plain INVALID_ARGUMENT with an unrelated message", () => {
    const err = grpcError(3, "3 INVALID_ARGUMENT: Unsupported audio encoding");
    expect(isModerationRejectionError(err)).toBe(false);
  });

  it("does not match a different gRPC code", () => {
    const err = grpcError(13, "13 INTERNAL: Received RST_STREAM with code 2 (Internal server error)");
    expect(isModerationRejectionError(err)).toBe(false);
  });

  it("does not match a non-Error value", () => {
    expect(isModerationRejectionError("usage guidelines")).toBe(false);
  });
});
