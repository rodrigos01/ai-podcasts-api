import { describe, expect, it } from "vitest";
import { AdtsFrameAccumulator, countAdtsFrames, getAdtsDurationSeconds, resolveTimeToByteOffset } from "../src/utils/adts";

/**
 * Builds a minimal, spec-valid ADTS frame (7-byte header, no CRC —
 * protection_absent=1) with a given payload size. Only the fields our
 * parser reads (sync word, protection_absent, frame_length) are meaningful;
 * profile/sampling-rate/channel-config bits are set to arbitrary fixed
 * values, mirroring how the existing Ogg tests built minimal-but-valid
 * pages for parser testing rather than exercising a real encoder.
 */
function buildAdtsFrame(payloadLength: number): Buffer {
  const headerLength = 7;
  const frameLength = headerLength + payloadLength;
  const header = Buffer.alloc(headerLength);
  header[0] = 0xff;
  header[1] = 0xf1; // syncword low bits + MPEG-4 + layer 00 + protection_absent=1
  header[2] = 0x50; // profile/sampling_freq_index/private/channel_config-high (arbitrary)
  header[3] = (0x01 << 6) | ((frameLength >> 11) & 0x03); // channel_config-low (arbitrary) + frame_length bits 12-11
  header[4] = (frameLength >> 3) & 0xff; // frame_length bits 10-3
  header[5] = ((frameLength & 0x07) << 5) | 0x1f; // frame_length bits 2-0 + buffer_fullness-high (arbitrary)
  header[6] = 0xfc; // buffer_fullness-low + num_raw_data_blocks (arbitrary)
  return Buffer.concat([header, Buffer.alloc(payloadLength, 0xab)]);
}

describe("AdtsFrameAccumulator", () => {
  it("returns a complete frame fed in one push", () => {
    const frame = buildAdtsFrame(20);
    const acc = new AdtsFrameAccumulator();
    expect(acc.push(frame)).toEqual([frame]);
    expect(() => acc.assertDrained()).not.toThrow();
  });

  it("reassembles a frame split across many small pushes", () => {
    const frame = buildAdtsFrame(20);
    const acc = new AdtsFrameAccumulator();
    const collected: Buffer[] = [];
    for (let i = 0; i < frame.length; i++) {
      collected.push(...acc.push(frame.subarray(i, i + 1)));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(frame);
    expect(() => acc.assertDrained()).not.toThrow();
  });

  it("extracts multiple frames delivered in one push", () => {
    const frames = [buildAdtsFrame(20), buildAdtsFrame(30)];
    const acc = new AdtsFrameAccumulator();
    expect(acc.push(Buffer.concat(frames))).toEqual(frames);
  });

  it("throws on assertDrained when a partial frame never completed", () => {
    const frame = buildAdtsFrame(20);
    const acc = new AdtsFrameAccumulator();
    acc.push(frame.subarray(0, frame.length - 1));
    expect(() => acc.assertDrained()).toThrow(/incomplete/i);
  });
});

describe("countAdtsFrames / getAdtsDurationSeconds", () => {
  it("counts frames and derives duration from the fixed 1024-samples/frame assumption", () => {
    const buffer = Buffer.concat([buildAdtsFrame(20), buildAdtsFrame(30), buildAdtsFrame(15)]);
    expect(countAdtsFrames(buffer)).toBe(3);
    expect(getAdtsDurationSeconds(buffer, 24000)).toBeCloseTo((3 * 1024) / 24000);
  });

  it("throws on a truncated stream", () => {
    const frame = buildAdtsFrame(20);
    expect(() => countAdtsFrames(frame.subarray(0, frame.length - 1))).toThrow(/truncated/i);
  });
});

describe("resolveTimeToByteOffset", () => {
  const sampleRate = 24000;
  const frameDuration = 1024 / sampleRate;
  // 3 frames per chunk, 2 chunks — each chunk spans 3 * frameDuration seconds.
  const chunkBuffers = [0, 1].map(() =>
    Buffer.concat([buildAdtsFrame(20), buildAdtsFrame(20), buildAdtsFrame(20)]),
  );
  const chunkSize = chunkBuffers[0]!.length;

  function makeChunkAccessors(cachedCount: number) {
    const cachedSizeAt = (index: number) => (index < cachedCount ? chunkSize : null);
    const fetchCachedBytes = async (index: number) =>
      index < cachedCount ? (chunkBuffers[index] ?? null) : null;
    return { cachedSizeAt, fetchCachedBytes };
  }

  it("resumes at byte 0 for time 0", async () => {
    const { cachedSizeAt, fetchCachedBytes } = makeChunkAccessors(2);
    expect(await resolveTimeToByteOffset(0, sampleRate, 2, cachedSizeAt, fetchCachedBytes)).toBe(0);
  });

  it("resolves to the frame boundary at-or-before the requested time, with sub-chunk precision", async () => {
    const { cachedSizeAt, fetchCachedBytes } = makeChunkAccessors(2);
    // Land inside the 2nd frame of chunk 0 (each frame is frameDuration long,
    // each ADTS frame in our fixture is 27 bytes: 7-byte header + 20-byte payload).
    const target = frameDuration * 1.5;
    const offset = await resolveTimeToByteOffset(target, sampleRate, 2, cachedSizeAt, fetchCachedBytes);
    expect(offset).toBe(27); // exactly one frame's worth — sub-chunk precision, not whole-chunk
  });

  it("stops at the first not-yet-cached chunk even if the requested time is further ahead", async () => {
    const { cachedSizeAt, fetchCachedBytes } = makeChunkAccessors(1);
    const offset = await resolveTimeToByteOffset(100, sampleRate, 2, cachedSizeAt, fetchCachedBytes);
    expect(offset).toBe(chunkSize);
  });

  it("returns the total cached length when the requested time is beyond everything cached", async () => {
    const { cachedSizeAt, fetchCachedBytes } = makeChunkAccessors(2);
    const offset = await resolveTimeToByteOffset(1000, sampleRate, 2, cachedSizeAt, fetchCachedBytes);
    expect(offset).toBe(chunkSize * 2);
  });
});
