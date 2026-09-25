import { describe, expect, it } from "vitest";
import { createMockAdtsFrame, getAdtsDurationSeconds } from "../src/utils/aac";

describe("aac utilities", () => {
  it("computes duration correctly from mock ADTS frames", () => {
    // 24000 Hz, each frame is 1024 samples = 1024 / 24000 = 0.042666...s
    // 234.375 frames = 10 seconds. Let's make 235 frames: 235 * 1024 / 24000 = 10.02666s
    const frames = Array.from({ length: 235 }, () => createMockAdtsFrame(150, 6));
    const combined = Buffer.concat(frames);

    const duration = getAdtsDurationSeconds(combined);
    expect(duration).toBeCloseTo(10.026, 2);
  });

  it("handles empty or corrupted buffer gracefully", () => {
    expect(getAdtsDurationSeconds(Buffer.alloc(0))).toBe(0);
    expect(getAdtsDurationSeconds(Buffer.from([1, 2, 3, 4]))).toBe(0);
  });
});
