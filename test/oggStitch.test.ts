import { describe, expect, it } from "vitest";
import { OggPageAccumulator, OggStitcher } from "../src/utils/oggStitch";

/** Builds a minimal, spec-valid single-page Ogg page for the given fields. */
function buildPage(opts: {
  serial: number;
  sequence: number;
  granule: bigint;
  eos?: boolean;
  bos?: boolean;
  payload: Buffer;
}): Buffer {
  const { serial, sequence, granule, eos = false, bos = false, payload } = opts;
  const segmentCount = Math.ceil(payload.length / 255) || 1;
  const header = Buffer.alloc(27 + segmentCount);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0);
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

function opusHeadPage(serial: number, sequence: number): Buffer {
  return buildPage({
    serial,
    sequence,
    granule: 0n,
    bos: true,
    payload: Buffer.concat([Buffer.from("OpusHead", "ascii"), Buffer.alloc(11)]),
  });
}

function opusTagsPage(serial: number, sequence: number): Buffer {
  return buildPage({
    serial,
    sequence,
    granule: 0n,
    payload: Buffer.concat([Buffer.from("OpusTags", "ascii"), Buffer.alloc(4)]),
  });
}

function audioPage(serial: number, sequence: number, granule: bigint, eos = false): Buffer {
  return buildPage({ serial, sequence, granule, eos, payload: Buffer.from([0xab, 0xcd]) });
}

interface ParsedPage {
  serial: number;
  sequence: number;
  granule: bigint;
  eos: boolean;
  bos: boolean;
  isHead: boolean;
  isTags: boolean;
}

function readPages(buffer: Buffer): ParsedPage[] {
  const pages: ParsedPage[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const numSegments = buffer[offset + 26]!;
    let payloadLength = 0;
    for (let i = 0; i < numSegments; i++) payloadLength += buffer[offset + 27 + i]!;
    const payloadStart = offset + 27 + numSegments;
    const magic = buffer.subarray(payloadStart, payloadStart + 8).toString("ascii");
    pages.push({
      serial: buffer.readUInt32LE(offset + 14),
      sequence: buffer.readUInt32LE(offset + 18),
      granule: buffer.readBigUInt64LE(offset + 6),
      eos: (buffer[offset + 5]! & 0x04) !== 0,
      bos: (buffer[offset + 5]! & 0x02) !== 0,
      isHead: magic === "OpusHead",
      isTags: magic === "OpusTags",
    });
    offset = payloadStart + payloadLength;
  }
  return pages;
}

/** Runs a whole chunk's raw pages through the stitcher, mirroring audio.service.ts's usage. */
function stitchChunk(
  stitcher: OggStitcher,
  rawPages: Buffer[],
  isFirstChunk: boolean,
  isLastChunk: boolean,
): Buffer[] {
  stitcher.startChunk();
  const out: Buffer[] = [];
  for (const page of rawPages) {
    const rewritten = stitcher.processPage(page, isFirstChunk, isLastChunk);
    if (rewritten) out.push(rewritten.page);
  }
  stitcher.endChunk();
  return out;
}

describe("OggStitcher", () => {
  it("passes a single-chunk episode through unchanged", () => {
    const raw = [
      opusHeadPage(111, 0),
      opusTagsPage(111, 1),
      audioPage(111, 2, 48000n),
      audioPage(111, 3, 96000n, true),
    ];
    const stitcher = new OggStitcher();
    const out = stitchChunk(stitcher, raw, true, true).flatMap(readPages);

    expect(out).toEqual(raw.flatMap(readPages));
  });

  it("stitches two chunks into one continuous, non-chained stream", () => {
    const chunk0 = [
      opusHeadPage(111, 0),
      opusTagsPage(111, 1),
      audioPage(111, 2, 48000n),
      audioPage(111, 3, 96000n, true), // chunk 0's own true end
    ];
    const chunk1 = [
      opusHeadPage(222, 0), // different serial — a fresh encoder session
      opusTagsPage(222, 1),
      audioPage(222, 2, 24000n),
      audioPage(222, 3, 72000n, true), // chunk 1's own true end == episode's true end
    ];

    const stitcher = new OggStitcher();
    const out = [
      ...stitchChunk(stitcher, chunk0, true, false),
      ...stitchChunk(stitcher, chunk1, false, true),
    ];
    const pages = out.flatMap(readPages);

    // Exactly one header pair, from chunk 0 only.
    expect(pages.filter((p) => p.isHead)).toHaveLength(1);
    expect(pages.filter((p) => p.isTags)).toHaveLength(1);

    // One consistent serial across every page.
    expect(new Set(pages.map((p) => p.serial)).size).toBe(1);
    expect(pages[0]!.serial).toBe(111);

    // Gapless, monotonic sequence numbers.
    expect(pages.map((p) => p.sequence)).toEqual(pages.map((_, i) => i));

    // Continuous granule timeline: chunk 1's audio pages continue from
    // chunk 0's max granule (96000).
    const audioGranules = pages.filter((p) => !p.isHead && !p.isTags).map((p) => p.granule);
    expect(audioGranules).toEqual([48000n, 96000n, 24000n + 96000n, 72000n + 96000n]);

    // Exactly one EOS page, on the true final page of the true final chunk.
    expect(pages.filter((p) => p.eos)).toHaveLength(1);
    expect(pages.at(-1)!.eos).toBe(true);

    // No BOS on anything but chunk 0's OpusHead is naturally already the
    // only page that had it; stitching never introduces a new one.
    expect(pages.filter((p) => p.bos)).toHaveLength(1);
    expect(pages[0]!.bos).toBe(true);
  });

  it("leaves the Ogg 'no packet completes on this page' granule sentinel untouched", () => {
    const NO_GRANULE = 0xffffffffffffffffn;
    const chunk0 = [opusHeadPage(1, 0), opusTagsPage(1, 1), audioPage(1, 2, 48000n, true)];
    const chunk1 = [opusHeadPage(2, 0), opusTagsPage(2, 1), audioPage(2, 2, NO_GRANULE, true)];

    const stitcher = new OggStitcher();
    stitchChunk(stitcher, chunk0, true, false);
    const out1 = stitchChunk(stitcher, chunk1, false, true);
    const pages = out1.flatMap(readPages);

    expect(pages[0]!.granule).toBe(NO_GRANULE);
  });

  it("continues correctly from a chunk 0 already served from cache", () => {
    // Simulates: this request only needs to generate chunk 1; chunk 0's
    // already-rewritten bytes came straight from the cache.
    const cachedChunk0 = Buffer.concat(
      stitchChunk(
        new OggStitcher(),
        [opusHeadPage(111, 0), opusTagsPage(111, 1), audioPage(111, 2, 96000n, true)],
        true,
        false,
      ),
    );

    const stitcher = new OggStitcher();
    stitcher.deriveFromCachedBuffer(cachedChunk0, true);

    const chunk1Raw = [
      opusHeadPage(222, 0),
      opusTagsPage(222, 1),
      audioPage(222, 2, 48000n, true),
    ];
    const out = stitchChunk(stitcher, chunk1Raw, false, true).flatMap(readPages);

    expect(out.filter((p) => p.isHead || p.isTags)).toHaveLength(0);
    expect(out[0]!.serial).toBe(111);
    expect(out[0]!.sequence).toBe(3); // continues past cached chunk 0's last sequence (2)
    expect(out[0]!.granule).toBe(48000n + 96000n);
    expect(out[0]!.eos).toBe(true);
  });

  // audio.service.ts skips a chunk whose TTS generation fails outright
  // (e.g. a content-moderation false positive) rather than aborting the
  // whole stream — it does this by calling startChunk()/endChunk() around
  // the failed attempt with zero (or partial) processPage calls in
  // between, exactly like a real attempt that failed before/during
  // producing audio. These two tests simulate that directly, using the
  // real class, to confirm the following chunk's timeline stays correct.
  it("keeps the timeline correct when a chunk is skipped after contributing zero audio", () => {
    const chunk0 = [opusHeadPage(111, 0), opusTagsPage(111, 1), audioPage(111, 2, 96000n)];
    const chunk2 = [opusHeadPage(333, 0), opusTagsPage(333, 1), audioPage(333, 2, 48000n, true)];

    const stitcher = new OggStitcher();
    stitchChunk(stitcher, chunk0, true, false);

    // Chunk 1 fails before any page ever arrives — exactly what
    // audio.service.ts's catch block does: startChunk() already ran
    // inside generateOrJoin before the failure, so just endChunk() with
    // nothing processed in between.
    stitcher.startChunk();
    stitcher.endChunk();

    const out = stitchChunk(stitcher, chunk2, false, true).flatMap(readPages);

    // Chunk 2 continues from chunk 0's granule (96000) — the skipped
    // chunk 1 contributed nothing, not a gap and not a rollback.
    expect(out[0]!.granule).toBe(48000n + 96000n);
    // Sequence continues gaplessly too — skipping a chunk doesn't skip
    // sequence numbers, since chunk 1 simply never emitted any pages.
    expect(out[0]!.sequence).toBe(3);
    expect(out.at(-1)!.eos).toBe(true);
  });

  it("commits whatever partial audio a skipped chunk emitted before failing, not just zero", () => {
    const chunk0 = [opusHeadPage(111, 0), opusTagsPage(111, 1), audioPage(111, 2, 96000n)];
    const chunk2 = [opusHeadPage(333, 0), opusTagsPage(333, 1), audioPage(333, 2, 48000n, true)];

    const stitcher = new OggStitcher();
    stitchChunk(stitcher, chunk0, true, false);

    // Chunk 1 emits one real audio page (already streamed to the client
    // via onDelta) before failing partway through — that granule progress
    // is irreversible (the client already has those bytes) and must be
    // committed, not discarded, when the failure is caught.
    stitcher.startChunk();
    const rewritten = stitcher.processPage(audioPage(222, 2, 24000n), false, false);
    expect(rewritten).not.toBeNull();
    stitcher.endChunk();

    const out = stitchChunk(stitcher, chunk2, false, true).flatMap(readPages);

    // Continues from 96000 (chunk 0) + 24000 (chunk 1's partial progress).
    expect(out[0]!.granule).toBe(48000n + 96000n + 24000n);
  });
});

describe("OggPageAccumulator", () => {
  it("returns a complete page fed in one push", () => {
    const page = audioPage(1, 0, 1000n);
    const acc = new OggPageAccumulator();
    expect(acc.push(page)).toEqual([page]);
    expect(() => acc.assertDrained()).not.toThrow();
  });

  it("reassembles a page split across many small pushes", () => {
    const page = audioPage(1, 0, 1000n);
    const acc = new OggPageAccumulator();
    const collected: Buffer[] = [];
    for (let i = 0; i < page.length; i++) {
      collected.push(...acc.push(page.subarray(i, i + 1)));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(page);
    expect(() => acc.assertDrained()).not.toThrow();
  });

  it("extracts multiple pages delivered in one push", () => {
    const pages = [audioPage(1, 0, 1000n), audioPage(1, 1, 2000n)];
    const acc = new OggPageAccumulator();
    expect(acc.push(Buffer.concat(pages))).toEqual(pages);
  });

  it("throws on assertDrained when a partial page never completed", () => {
    const page = audioPage(1, 0, 1000n);
    const acc = new OggPageAccumulator();
    acc.push(page.subarray(0, page.length - 1));
    expect(() => acc.assertDrained()).toThrow(/incomplete/i);
  });
});
