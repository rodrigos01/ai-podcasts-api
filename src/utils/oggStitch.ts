// Cloud TTS's streamingSynthesize caps a single call at roughly 178s of
// audio (undocumented, empirically found — see AGENTS.md), so an episode is
// always synthesized as several independent Ogg Opus chunks, each its own
// complete logical bitstream (own OpusHead/OpusTags, own serial number, own
// granule timeline from 0, own EOS page). Byte-concatenating those directly
// produces a "chained" Ogg bitstream, which is fragile in practice — even
// ffmpeg's own demuxer errors at each chunk boundary and misreports total
// duration, and Android's ExoPlayer doesn't support it at all.
//
// This module rewrites each chunk's pages, as they're produced, into a
// single continuous, non-chained logical stream: every chunk's own
// OpusHead/OpusTags are dropped (the episode's one true header is the fixed
// OGG_HEADER_PAGES constant below, written once by audio.service.ts before
// any chunk synthesis starts — see its own comment for why), one serial
// number, monotonically increasing page sequence numbers, a continuous
// granule (sample-position) timeline across chunk boundaries, and exactly
// one true EOS page at the real end of the episode. No re-encoding — only
// fixed-width header fields are patched and the page's CRC-32 is
// recomputed, so the underlying Opus audio is untouched.

import { OPUS_GRANULE_RATE } from "./oggOpus";

const CAPTURE_PATTERN = "OggS";
const OPUS_HEAD_MAGIC = Buffer.from("OpusHead", "ascii");
const OPUS_TAGS_MAGIC = Buffer.from("OpusTags", "ascii");
// Ogg's "no packet completes on this page" sentinel — must be left as-is,
// never offset, per RFC 3533.
const NO_GRANULE = 0xffffffffffffffffn;

/**
 * A fixed, hardcoded OpusHead+OpusTags page pair, captured live from a real
 * Cloud TTS `streamingSynthesize` response (2026-09-23) — confirmed
 * byte-for-byte identical across several separate calls with different
 * director prompts, text, and voices, including the serial number (0) and
 * page sequence numbers (0, 1), not just the payload. Cloud TTS's header
 * only depends on the fixed request config (`audioEncoding: "OGG_OPUS"`,
 * `sampleRateHertz: 24000` — see geminiClient.ts's streamSpeech), never on
 * the actual synthesized content, so it doesn't need to come from any
 * particular chunk's real output.
 *
 * audio.service.ts writes these exact bytes once, unconditionally, before
 * any chunk synthesis starts — every chunk's own OpusHead/OpusTags (which
 * OggStitcher drops below) are therefore always redundant, not just every
 * chunk after the first. That decouples the episode's header from chunk
 * 0's success: a chunk-0 TTS failure is exactly as recoverable (silently
 * skippable) as any other chunk's, instead of the unrecoverable special
 * case it used to be when the header came from chunk 0's own output.
 *
 * If Cloud TTS's encoder output ever changes (a different
 * audioEncoding/sampleRateHertz, or a backend change to the encoder
 * itself), these bytes — and HEADER_SERIAL below — would need recapturing.
 */
export const OGG_HEADER_PAGES = Buffer.from(
  "4f676753000200000000000000000000000000000000435ec1a101134f7075734865616401013801c05d0000000000" +
    "4f6767530000000000000000000000000000010000004ac238f2012b4f707573546167731b000000476f6f676c6520" +
    "537065656368207573696e67206c69626f70757300000000",
  "hex",
);

// The serial number embedded in OGG_HEADER_PAGES above, and OpusTags'
// (the header's second page) own sequence number — processPage's
// pre-increment pattern (`nextSequence += 1` then assign) means starting
// here makes the first real audio page land on sequence 2, right after the
// header's own 0 and 1.
const HEADER_SERIAL = 0;
const HEADER_TAGS_SEQUENCE = 1;

const CRC_LOOKUP = buildCrcLookup();

function buildCrcLookup(): Int32Array {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r | 0;
  }
  return table;
}

/** RFC 3533 Ogg CRC-32 — the checksum field itself (bytes 22-25) reads as 0 while computing. */
function calculateOggCrc(page: Buffer): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byteValue = i >= 22 && i <= 25 ? 0 : page[i]!;
    const index = ((crc >>> 24) ^ byteValue) & 0xff;
    crc = (crc << 8) ^ CRC_LOOKUP[index]!;
  }
  return crc | 0;
}

/**
 * Returns the byte length of the Ogg page starting at `offset`, or null if
 * `buffer` doesn't yet contain the whole page (more bytes needed — used by
 * OggPageAccumulator to know when to wait for the next delta). Throws if
 * `offset` isn't the start of a valid page at all, since unlike an
 * arbitrary upstream byte stream, our input is Cloud TTS's own gRPC output
 * consumed by our own page-aligned advancement — a mismatch here means a
 * real bug, not a resync-able transport glitch.
 */
function readPageLength(buffer: Buffer, offset: number): number | null {
  if (offset + 27 > buffer.length) return null;
  if (buffer.toString("ascii", offset, offset + 4) !== CAPTURE_PATTERN) {
    throw new Error(`Expected Ogg page capture pattern at offset ${offset}`);
  }
  const numSegments = buffer[offset + 26]!;
  const segmentTableEnd = offset + 27 + numSegments;
  if (segmentTableEnd > buffer.length) return null;
  let payloadLength = 0;
  for (let i = offset + 27; i < segmentTableEnd; i++) payloadLength += buffer[i]!;
  const totalLength = segmentTableEnd + payloadLength - offset;
  if (offset + totalLength > buffer.length) return null;
  return totalLength;
}

function isMagicAt(page: Buffer, magic: Buffer): boolean {
  const numSegments = page[26]!;
  const payloadStart = 27 + numSegments;
  if (payloadStart + magic.length > page.length) return false;
  return page.subarray(payloadStart, payloadStart + magic.length).equals(magic);
}

function getGranule(page: Buffer): bigint {
  return page.readBigUInt64LE(6);
}
function setGranule(page: Buffer, value: bigint): void {
  page.writeBigUInt64LE(value, 6);
}
function getSerial(page: Buffer): number {
  return page.readUInt32LE(14);
}
function setSerial(page: Buffer, value: number): void {
  page.writeUInt32LE(value >>> 0, 14);
}
function getSequence(page: Buffer): number {
  return page.readUInt32LE(18);
}
function setSequence(page: Buffer, value: number): void {
  page.writeUInt32LE(value >>> 0, 18);
}
function setChecksum(page: Buffer, value: number): void {
  page.writeInt32LE(value, 22);
}

/**
 * Incrementally extracts complete Ogg pages from a series of arbitrary
 * byte fragments (Cloud TTS's gRPC deltas don't align to page boundaries).
 * Scoped to a single chunk's generation — create a fresh instance per chunk.
 */
export class OggPageAccumulator {
  private leftover: Buffer = Buffer.alloc(0);

  /** Feeds one more delta; returns however many complete pages are now available (possibly none). */
  push(delta: Buffer): Buffer[] {
    this.leftover = this.leftover.length > 0 ? Buffer.concat([this.leftover, delta]) : delta;

    const pages: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const length = readPageLength(this.leftover, offset);
      if (length === null) break;
      pages.push(this.leftover.subarray(offset, offset + length));
      offset += length;
    }
    this.leftover = offset > 0 ? Buffer.from(this.leftover.subarray(offset)) : this.leftover;
    return pages;
  }

  /** Call once a chunk's stream has ended — throws if a partial page was never completed. */
  assertDrained(): void {
    if (this.leftover.length > 0) {
      throw new Error(
        `TTS chunk ended with an incomplete Ogg page (${this.leftover.length} leftover bytes)`,
      );
    }
  }
}

/**
 * Holds the running cross-chunk state needed to rewrite a sequence of
 * independently-produced Ogg Opus chunks into one continuous logical
 * stream. One instance per episode-streaming request, fed chunks strictly
 * in order (the same order they're already processed in
 * audio.service.ts's streamEpisodeAudio loop).
 */
export class OggStitcher {
  private nextSequence = HEADER_TAGS_SEQUENCE;
  private cumulativeGranule = 0n;
  private chunkMaxGranule = 0n;

  /** Call before feeding any pages of a new chunk. */
  startChunk(): void {
    this.chunkMaxGranule = 0n;
  }

  /** Call once a chunk's pages have all been processed. */
  endChunk(): void {
    this.cumulativeGranule += this.chunkMaxGranule;
    this.chunkMaxGranule = 0n;
  }

  /**
   * The episode's total audio duration generated so far, in seconds —
   * accurate as of the last completed `endChunk()`/`deriveFromCachedBuffer`
   * call. Used to persist `Episode.generatedAudioSeconds` after each chunk
   * actually finishes generating (see audio.service.ts).
   */
  getCumulativeSeconds(): number {
    return Number(this.cumulativeGranule) / OPUS_GRANULE_RATE;
  }

  /**
   * How much audio the chunk *currently* being processed (since the last
   * `startChunk()`) has produced so far — unlike `getCumulativeSeconds()`,
   * which only advances on `endChunk()`, this updates live as pages arrive
   * mid-chunk. Used by `audio.service.ts`'s `generateOrJoin` to detect a
   * chunk whose synthesis has run away (see MAX_CHUNK_AUDIO_SECONDS in
   * ttsLimits.ts) before it ever reaches `endChunk()`.
   */
  getCurrentChunkSeconds(): number {
    return Number(this.chunkMaxGranule) / OPUS_GRANULE_RATE;
  }

  /**
   * Rewrites one raw audio page from the chunk currently being processed
   * into its place in the single continuous output. Returns null for a
   * page that should be dropped entirely — every chunk's own
   * OpusHead/OpusTags, always redundant now that the episode's one and only
   * header is the fixed OGG_HEADER_PAGES constant, written once by the
   * caller before any chunk synthesis even starts (see audio.service.ts).
   * That makes chunk 0 structurally identical to every other chunk here —
   * there's no first-chunk special case left in this class at all.
   */
  processPage(rawPage: Buffer, isLastChunk: boolean): Buffer | null {
    if (isMagicAt(rawPage, OPUS_HEAD_MAGIC) || isMagicAt(rawPage, OPUS_TAGS_MAGIC)) return null;

    const page = Buffer.from(rawPage);
    const rawGranule = getGranule(page);
    if (rawGranule !== NO_GRANULE && rawGranule > this.chunkMaxGranule) {
      this.chunkMaxGranule = rawGranule;
    }

    // Clear EOS unless this is truly the episode's last chunk — Cloud TTS
    // only ever sets EOS on a chunk's own true final raw page, so preserving
    // that bit verbatim exactly when isLastChunk is true is already correct
    // with no page-position tracking needed. BOS never appears on an audio
    // page in a well-formed stream; cleared here only for defense in depth.
    let headerType = page[5]!;
    if (!isLastChunk) headerType &= ~0x04;
    headerType &= ~0x02;
    page[5] = headerType;

    setSerial(page, HEADER_SERIAL);
    this.nextSequence += 1;
    setSequence(page, this.nextSequence);

    if (rawGranule !== NO_GRANULE) {
      setGranule(page, rawGranule + this.cumulativeGranule);
    }

    setChecksum(page, calculateOggCrc(page));
    return page;
  }

  /**
   * Brings this stitcher's state up to date from a chunk served straight
   * from cache (already fully rewritten by whichever request originally
   * generated it) — no rewriting needed, just enough bookkeeping so that a
   * *later* chunk needing fresh generation in this same request continues
   * the timeline correctly. Since a cached chunk's bytes are already in
   * absolute (stitched) form, its last page's sequence/granule are used
   * directly rather than accumulated.
   */
  deriveFromCachedBuffer(buffer: Buffer): void {
    let offset = 0;
    let lastPage: Buffer | null = null;
    while (offset < buffer.length) {
      const length = readPageLength(buffer, offset);
      if (length === null) throw new Error("Cached Ogg chunk is truncated");
      lastPage = buffer.subarray(offset, offset + length);
      offset += length;
    }
    if (!lastPage) throw new Error("Cached Ogg chunk contains no pages");

    this.nextSequence = getSequence(lastPage);
    this.cumulativeGranule = getGranule(lastPage);
    this.chunkMaxGranule = 0n;
  }
}
