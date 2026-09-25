import { describe, expect, it } from "vitest";
import { buildContentItems, looksLikeModerationRejection, soloSpeakerLabel } from "../src/llm/ttsClient";
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

describe("buildContentItems", () => {
  it("builds content items with speaker and style in multiSpeaker mode", () => {
    const turns: ScriptTurn[] = [
      { speaker: "Marcus", text: "Look at this [whispers] carefully.", style: "whispering" },
      { speaker: "Ray", text: "I see it!" },
    ];
    const items = buildContentItems(turns, true);
    expect(items).toEqual([
      {
        type: "text",
        text: "Look at this <whispers> carefully.",
        annotations: [
          {
            type: "speech_metadata",
            speaker: "Marcus",
            style: "whispering",
          },
        ],
      },
      {
        type: "text",
        text: "I see it!",
        annotations: [
          {
            type: "speech_metadata",
            speaker: "Ray",
          },
        ],
      },
    ]);
  });

  it("builds content items with style in single speaker mode", () => {
    const turns: ScriptTurn[] = [
      { speaker: "Marcus", text: "Quiet now.", style: "softly" },
      { speaker: "Marcus", text: "Back to normal." },
    ];
    const items = buildContentItems(turns, false);
    expect(items).toEqual([
      {
        type: "text",
        text: "Quiet now.",
        annotations: [
          {
            type: "speech_metadata",
            style: "softly",
          },
        ],
      },
      {
        type: "text",
        text: "Back to normal.",
        annotations: undefined,
      },
    ]);
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

