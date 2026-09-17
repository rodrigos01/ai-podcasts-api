import { describe, expect, it } from "vitest";
import { getOggOpusDurationSeconds, resolveTimeToByteOffset } from "../src/utils/oggOpus";

/**
 * Builds a minimal, spec-valid single-page Ogg stream (RFC 3533) with a
 * given granule position and payload size — enough for
 * getOggOpusDurationSeconds to find and parse without needing a real
 * Cloud TTS response.
 */
function buildOggPage(granulePosition: bigint, payloadLength: number): Buffer {
  const segmentCount = Math.ceil(payloadLength / 255) || 1;
  const header = Buffer.alloc(27 + segmentCount);
  header.write("OggS", 0, "ascii");
  header[4] = 0; // version
  header[5] = 0; // header type flags
  header.writeBigUInt64LE(granulePosition, 6);
  header.writeUInt32LE(1, 14); // serial number
  header.writeUInt32LE(0, 18); // page sequence number
  header.writeUInt32LE(0, 22); // CRC (unchecked by our parser)
  header[26] = segmentCount;

  let remaining = payloadLength;
  for (let i = 0; i < segmentCount; i++) {
    const lace = Math.min(remaining, 255);
    header[27 + i] = lace;
    remaining -= lace;
  }

  return Buffer.concat([header, Buffer.alloc(payloadLength, 0xab)]);
}

describe("getOggOpusDurationSeconds", () => {
  it("derives duration from the final page's granule position (units of 1/48000s)", () => {
    const page = buildOggPage(48000n * 3n, 10); // 3 seconds of audio
    expect(getOggOpusDurationSeconds(page)).toBe(3);
  });

  it("uses the last page when multiple pages are concatenated", () => {
    const first = buildOggPage(48000n * 1n, 10);
    const second = buildOggPage(48000n * 5n, 300); // needs 2 segments (>255 bytes)
    expect(getOggOpusDurationSeconds(Buffer.concat([first, second]))).toBe(5);
  });

  it("does not mistake a coincidental 'OggS' inside payload bytes for a page header", () => {
    const page = buildOggPage(48000n * 4n, 50);
    // Plant a fake capture pattern inside the payload, before the real header
    // at offset 0 — the backward scan must hit and reject this before
    // finding the real page (its bogus "segment table" fails to line up
    // with the buffer's actual end).
    page.write("OggS", page.length - 40, "ascii");
    expect(getOggOpusDurationSeconds(page)).toBe(4);
  });

  it("throws when no valid Ogg page exists", () => {
    expect(() => getOggOpusDurationSeconds(Buffer.from("not an ogg file"))).toThrow();
  });
});

describe("resolveTimeToByteOffset", () => {
  const chunkDurations = [2, 2, 2]; // seconds
  const chunkSizes = [1000, 1000, 1000]; // bytes
  const buffers = chunkDurations.map((seconds) => buildOggPage(48000n * BigInt(seconds), 0));

  function makeChunkAccessors(cachedCount: number) {
    const cachedSizeAt = (index: number) => (index < cachedCount ? chunkSizes[index] ?? null : null);
    const fetchCachedBytes = async (index: number) =>
      index < cachedCount ? (buffers[index] ?? null) : null;
    return { cachedSizeAt, fetchCachedBytes };
  }

  it("resumes at byte 0 for time 0", async () => {
    const { cachedSizeAt, fetchCachedBytes } = makeChunkAccessors(3);
    expect(await resolveTimeToByteOffset(0, 3, cachedSizeAt, fetchCachedBytes)).toBe(0);
  });

  it("resumes at the chunk boundary at-or-before the requested time, not mid-chunk", async () => {
    const { cachedSizeAt, fetchCachedBytes } = makeChunkAccessors(3);
    // 3 seconds falls inside chunk 1 (which spans [2,4)) — resume at its start (byte 1000), not further in.
    expect(await resolveTimeToByteOffset(3, 3, cachedSizeAt, fetchCachedBytes)).toBe(1000);
  });

  it("stops at the first not-yet-cached chunk even if the requested time is further ahead", async () => {
    const { cachedSizeAt, fetchCachedBytes } = makeChunkAccessors(1);
    expect(await resolveTimeToByteOffset(10, 3, cachedSizeAt, fetchCachedBytes)).toBe(1000);
  });

  it("returns the total cached length when the requested time is beyond everything cached", async () => {
    const { cachedSizeAt, fetchCachedBytes } = makeChunkAccessors(3);
    expect(await resolveTimeToByteOffset(100, 3, cachedSizeAt, fetchCachedBytes)).toBe(3000);
  });
});
