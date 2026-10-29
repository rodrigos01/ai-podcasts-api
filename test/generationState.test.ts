import { describe, expect, it } from "vitest";
import { CLEAN_GENERATION_STATE } from "../src/utils/generationState";

describe("CLEAN_GENERATION_STATE", () => {
  it("resets everything a generation writes, including the stored interaction", () => {
    expect(CLEAN_GENERATION_STATE).toEqual({
      status: "generating",
      transcript: null,
      ttsChunks: null,
      interactionId: null,
      generatedAudioSeconds: 0,
      audioComplete: false,
      audioDurationSeconds: null,
      progress: null,
      error: null,
    });
  });
});
