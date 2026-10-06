import { describe, expect, it } from "vitest";
import {
  buildSpeechParts,
  isDesignedVoiceId,
  looksLikeModerationRejection,
  parsePcmMimeType,
  soloSpeakerLabel,
} from "../src/llm/ttsClient";
import type { ScriptTurn } from "../src/utils/scriptText";

describe("soloSpeakerLabel", () => {
  it("returns the shared speaker label when every turn shares one speaker", () => {
    const turns: ScriptTurn[] = [
      { speaker: "Marcus", text: "First part of the monologue." },
      { speaker: "Marcus", text: "Second part of the monologue." },
    ];
    expect(soloSpeakerLabel(turns)).toBe("Marcus");
  });

  it("returns null for a genuine two-speaker transcript", () => {
    const turns: ScriptTurn[] = [
      { speaker: "Marcus", text: "Hey Ray." },
      { speaker: "Ray", text: "Hey Marcus." },
    ];
    expect(soloSpeakerLabel(turns)).toBeNull();
  });

  it("returns null for an empty transcript", () => {
    expect(soloSpeakerLabel([])).toBeNull();
  });
});

describe("buildSpeechParts", () => {
  it("builds parts with speaker and style metadata in multiSpeaker mode", () => {
    const turns: ScriptTurn[] = [
      { speaker: "Marcus", text: "Look at this [whispers] carefully.", style: "whispering" },
      { speaker: "Ray", text: "I see it!" },
    ];
    expect(buildSpeechParts(turns, true)).toEqual([
      {
        text: "Look at this <whispers> carefully.",
        speechMetadata: { speaker: "Marcus", style: "whispering" },
      },
      {
        text: "I see it!",
        speechMetadata: { speaker: "Ray" },
      },
    ]);
  });

  it("drops turns with no spoken text instead of sending an empty text part", () => {
    // A turn that parsed with a speaker label but no words (e.g. the only
    // content was a Style annotation) must never reach the API as an empty
    // text part — Gemini TTS rejects that outright with "400 Missing text".
    const turns: ScriptTurn[] = [
      { speaker: "Marcus", text: "Hey Ray." },
      { speaker: "Ray", text: "  ", style: "laughs" },
      { speaker: "Marcus", text: "Anyway." },
    ];
    const parts = buildSpeechParts(turns, true);
    expect(parts).toHaveLength(2);
    expect(parts.every((part) => part.text.length > 0)).toBe(true);
  });

  it("omits the speaker and attaches only style in single speaker mode", () => {
    const turns: ScriptTurn[] = [
      { speaker: "Marcus", text: "Quiet now.", style: "softly" },
      { speaker: "Marcus", text: "Back to normal." },
    ];
    const parts = buildSpeechParts(turns, false);
    expect(parts).toEqual([
      { text: "Quiet now.", speechMetadata: { style: "softly" } },
      { text: "Back to normal." },
    ]);
    expect("speechMetadata" in parts[1]!).toBe(false);
  });
});

describe("looksLikeModerationRejection", () => {
  it("matches a message naming usage guidelines", () => {
    expect(looksLikeModerationRejection(new Error("violates usage guidelines"))).toBe(true);
  });

  it("matches a message naming safety or being blocked", () => {
    expect(looksLikeModerationRejection(new Error("blocked for safety reasons"))).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(looksLikeModerationRejection(new Error("network timeout"))).toBe(false);
  });

  it("does not match a non-Error value", () => {
    expect(looksLikeModerationRejection("usage guidelines")).toBe(false);
  });
});


describe("isDesignedVoiceId", () => {
  it("accepts Voice Design ids and rejects everything else", () => {
    expect(isDesignedVoiceId("voice_608aa278-a182-473d-bc46-65cb62ac08a3")).toBe(true);
    expect(isDesignedVoiceId("Puck")).toBe(false);
    expect(isDesignedVoiceId("voice_../etc")).toBe(false);
    expect(isDesignedVoiceId("voice_")).toBe(false);
  });
});

describe("parsePcmMimeType", () => {
  it("reads rate and channels from the mime type", () => {
    expect(parsePcmMimeType("audio/l16; rate=16000; channels=2")).toEqual({
      numChannels: 2,
      sampleRate: 16000,
      bitsPerSample: 16,
    });
  });

  it("falls back to 24kHz mono when absent", () => {
    expect(parsePcmMimeType(undefined)).toEqual({ numChannels: 1, sampleRate: 24000, bitsPerSample: 16 });
  });
});
