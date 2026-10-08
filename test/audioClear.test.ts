import { describe, expect, it } from "vitest";
import { assertAudioClearable } from "../src/utils/audioClear";
import { HttpError } from "../src/utils/HttpError";

describe("assertAudioClearable", () => {
  it("allows a finished or failed episode, including while its audio is being synthesized", () => {
    expect(() => assertAudioClearable("ready")).not.toThrow();
    expect(() => assertAudioClearable("streamable")).not.toThrow();
    expect(() => assertAudioClearable("failed")).not.toThrow();
  });

  it("refuses while the script is being generated", () => {
    expect(() => assertAudioClearable("generating")).toThrow(HttpError);
    try {
      assertAudioClearable("generating");
    } catch (err) {
      expect((err as HttpError).status).toBe(409);
    }
  });
});
