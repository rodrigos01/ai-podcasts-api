import { describe, expect, it } from "vitest";
import { createMockAdtsFrame, getAdtsDurationSeconds, sliceAdtsByTime } from "../src/utils/aac";

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

  describe("sliceAdtsByTime", () => {
    it("returns full buffer for targetSeconds <= 0", () => {
      const frame = createMockAdtsFrame(100, 6);
      const slice = sliceAdtsByTime(frame, 0);
      expect(slice.buffer).toEqual(frame);
      expect(slice.skippedSeconds).toBe(0);
      expect(slice.skippedBytes).toBe(0);
    });

    it("handles empty buffer gracefully", () => {
      const slice = sliceAdtsByTime(Buffer.alloc(0), 5);
      expect(slice.buffer.length).toBe(0);
      expect(slice.skippedSeconds).toBe(0);
      expect(slice.skippedBytes).toBe(0);
    });

    it("slices at exact ADTS frame boundary closest to targetSeconds", () => {
      // 10 frames of 100-byte payload (total frame length = 107 bytes each)
      // Each frame = 1024 / 24000 = 0.042667 seconds
      const frames = Array.from({ length: 10 }, () => createMockAdtsFrame(100, 6));
      const combined = Buffer.concat(frames);

      // targetSeconds = 0.1s
      // Frame 0: 0.042667s <= 0.1s -> skip
      // Frame 1: 0.085333s <= 0.1s -> skip
      // Frame 2: 0.128000s > 0.1s -> break
      // Should skip 2 frames (214 bytes)
      const slice = sliceAdtsByTime(combined, 0.1);
      expect(slice.skippedBytes).toBe(214);
      expect(slice.skippedSeconds).toBeCloseTo(0.0853, 3);
      expect(slice.buffer.length).toBe(combined.length - 214);
      // Valid syncword at start of sliced buffer
      expect(slice.buffer[0]).toBe(0xff);
      expect((slice.buffer[1]! & 0xf0)).toBe(0xf0);
    });

    it("returns empty buffer when targetSeconds exceeds total duration", () => {
      const frames = Array.from({ length: 5 }, () => createMockAdtsFrame(100, 6));
      const combined = Buffer.concat(frames);
      const slice = sliceAdtsByTime(combined, 100);
      expect(slice.buffer.length).toBe(0);
      expect(slice.skippedBytes).toBe(combined.length);
    });
  });
});
