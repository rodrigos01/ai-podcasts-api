import { describe, expect, it } from "vitest";
import type { Response } from "express";
import { writeChunk } from "../src/services/audio.service";

/** Builds a minimal, spec-valid single-page Ogg page for the given fields — same shape test/oggStitch.test.ts uses. */
function buildPage(opts: { serial: number; sequence: number; granule: bigint; payload: Buffer }): Buffer {
  const { serial, sequence, granule, payload } = opts;
  const segmentCount = Math.ceil(payload.length / 255) || 1;
  const header = Buffer.alloc(27 + segmentCount);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = 0;
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segmentCount;

  let remaining = payload.length;
  for (let i = 0; i < segmentCount; i++) {
    const lace = Math.min(remaining, 255);
    header[27 + i] = lace;
    remaining -= lace;
  }
  return Buffer.concat([header, payload]);
}

function opusHeadPage(): Buffer {
  return buildPage({
    serial: 111,
    sequence: 0,
    granule: 0n,
    payload: Buffer.concat([Buffer.from("OpusHead", "ascii"), Buffer.alloc(11)]),
  });
}

function opusTagsPage(): Buffer {
  return buildPage({
    serial: 111,
    sequence: 1,
    granule: 0n,
    payload: Buffer.concat([Buffer.from("OpusTags", "ascii"), Buffer.alloc(4)]),
  });
}

function audioPage(sequence: number, granule: bigint): Buffer {
  return buildPage({ serial: 111, sequence, granule, payload: Buffer.from([0xab, 0xcd]) });
}

/** A cached, already-stitched chunk 0 buffer: header pages + a couple of audio pages. */
function buildChunk0(): Buffer {
  return Buffer.concat([opusHeadPage(), opusTagsPage(), audioPage(2, 48000n), audioPage(3, 96000n)]);
}

/** Captures res.write() calls without needing a real express Response. */
function fakeResponse(): { res: Response; written: () => Buffer } {
  const chunks: Buffer[] = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    write: (buf: Buffer) => {
      chunks.push(Buffer.from(buf));
      return true;
    },
  } as unknown as Response;
  return { res, written: () => Buffer.concat(chunks) };
}

describe("writeChunk", () => {
  // Regression test for a real bug: a `?t=` seek landing well past chunk 0
  // (the overwhelmingly common case — chunk 0 is short) used to skip the
  // header injection entirely, since the old code only injected it when
  // `start` landed *inside* chunk 0's own small header region. That
  // produced a headerless, unparseable Ogg stream for any real seek.
  it("injects chunk 0's header even when the seek target lands entirely past chunk 0's own bytes", () => {
    const chunk0 = buildChunk0();
    const header = Buffer.concat([opusHeadPage(), opusTagsPage()]);
    const { res, written } = fakeResponse();

    // Simulates streamEpisodeAudio calling writeChunk for the *cached*
    // chunk 0 buffer while seeking to a much later chunk (chunkStart=0,
    // start=1_000_000 — far beyond chunk0's own ~70 bytes).
    writeChunk(res, chunk0, 0, 1_000_000, true);

    const out = written();
    expect(out.subarray(0, header.length)).toEqual(header);
    // Nothing from chunk 0's own audio content should follow — the seek
    // target is beyond it entirely, so only the header goes out.
    expect(out.length).toBe(header.length);
  });

  it("injects the header and still writes chunk 0's own remaining audio when the seek lands inside chunk 0", () => {
    const chunk0 = buildChunk0();
    const header = Buffer.concat([opusHeadPage(), opusTagsPage()]);
    const { res, written } = fakeResponse();

    // Seek to a byte offset inside chunk 0's own audio content (after the
    // header, before the end of the buffer).
    const seekTarget = header.length + 5;
    writeChunk(res, chunk0, 0, seekTarget, true);

    const out = written();
    expect(out.subarray(0, header.length)).toEqual(header);
    expect(out.subarray(header.length)).toEqual(chunk0.subarray(seekTarget));
  });

  it("writes the full chunk unmodified when there's no seek at all", () => {
    const chunk0 = buildChunk0();
    const { res, written } = fakeResponse();

    writeChunk(res, chunk0, 0, 0, true);

    expect(written()).toEqual(chunk0);
  });

  it("never injects a header for a non-zero chunk, regardless of the seek target", () => {
    const chunk1 = Buffer.concat([audioPage(0, 48000n), audioPage(1, 96000n)]);
    const { res, written } = fakeResponse();

    // mayNeedHeader=false — only ever true for chunk 0 at the call site.
    writeChunk(res, chunk1, 1_000_000, 1_000_050, false);

    // Plain writeSlice behavior: writes whatever of chunk1 falls at/after
    // the seek target, nothing extra.
    expect(written()).toEqual(chunk1.subarray(50));
  });
});
