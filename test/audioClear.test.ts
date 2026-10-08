import { describe, expect, it } from "vitest";
import { assertAudioClearable } from "../src/utils/audioClear";
import { HttpError } from "../src/utils/HttpError";

describe("assertAudioClearable", () => {
  it("allows a finished or failed episode with no chunk being generated", () => {
    expect(() => assertAudioClearable("ready", false)).not.toThrow();
    expect(() => assertAudioClearable("streamable", false)).not.toThrow();
    expect(() => assertAudioClearable("failed", false)).not.toThrow();
  });

  it("refuses while the script is being generated", () => {
    expect(() => assertAudioClearable("generating", false)).toThrow(HttpError);
    try {
      assertAudioClearable("generating", false);
    } catch (err) {
      expect((err as HttpError).status).toBe(409);
    }
  });

  it("refuses while a chunk is being synthesized", () => {
    expect(() => assertAudioClearable("ready", true)).toThrowError(/being generated right now/);
  });
});
