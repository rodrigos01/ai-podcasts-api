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
// single continuous, non-chained logical stream: one OpusHead/OpusTags, one
// serial number, monotonically increasing page sequence numbers, a
// continuous granule (sample-position) timeline across chunk boundaries,
// and exactly one true EOS page at the real end of the episode. No
// re-encoding — only fixed-width header fields are patched and the page's
// CRC-32 is recomputed, so the underlying Opus audio is untouched.

import { OPUS_GRANULE_RATE } from "./oggOpus";

const CAPTURE_PATTERN = "OggS";
const OPUS_HEAD_MAGIC = Buffer.from("OpusHead", "ascii");
const OPUS_TAGS_MAGIC = Buffer.from("OpusTags", "ascii");
// Ogg's "no packet completes on this page" sentinel — must be left as-is,
// never offset, per RFC 3533.
const NO_GRANULE = 0xffffffffffffffffn;

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
  private initialSerial: number | null = null;
  private nextSequence = 0;
  private cumulativeGranule = 0n;
  private chunkMaxGranule = 0n;
  private firstChunkHeaderDone = false;

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
   * Rewrites one raw page from the chunk currently being processed into its
   * place in the single continuous output. Returns null for a page that
   * should be dropped entirely — a later chunk's duplicate OpusHead/OpusTags.
   * `isHeader` marks the two pages the whole episode's OpusHead/OpusTags
   * live on (only ever true for chunk 0) — callers must relay these
   * unconditionally, even into a response that otherwise starts mid-stream
   * (a `?t=` resume), since they're the *only* copy of the stream's header
   * anywhere in the episode; every later chunk's own copy gets dropped here.
   */
  processPage(
    rawPage: Buffer,
    isFirstChunk: boolean,
    isLastChunk: boolean,
  ): { page: Buffer; isHeader: boolean } | null {
    const isHead = isMagicAt(rawPage, OPUS_HEAD_MAGIC);
    const isTags = isMagicAt(rawPage, OPUS_TAGS_MAGIC);

    if (isFirstChunk && !this.firstChunkHeaderDone) {
      if (isHead) {
        this.initialSerial = getSerial(rawPage);
        this.nextSequence = getSequence(rawPage);
        return { page: rawPage, isHeader: true };
      }
      if (isTags) {
        this.firstChunkHeaderDone = true;
        this.nextSequence = getSequence(rawPage);
        return { page: rawPage, isHeader: true };
      }
      this.firstChunkHeaderDone = true;
    }

    if (isHead || isTags) return null;

    if (this.initialSerial === null) {
      throw new Error("OggStitcher received an audio page before any OpusHead");
    }

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

    setSerial(page, this.initialSerial);
    this.nextSequence += 1;
    setSequence(page, this.nextSequence);

    if (rawGranule !== NO_GRANULE) {
      setGranule(page, rawGranule + this.cumulativeGranule);
    }

    setChecksum(page, calculateOggCrc(page));
    return { page, isHeader: false };
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
  deriveFromCachedBuffer(buffer: Buffer, isFirstChunk: boolean): void {
    let offset = 0;
    let firstPage: Buffer | null = null;
    let lastPage: Buffer | null = null;
    while (offset < buffer.length) {
      const length = readPageLength(buffer, offset);
      if (length === null) throw new Error("Cached Ogg chunk is truncated");
      lastPage = buffer.subarray(offset, offset + length);
      firstPage ??= lastPage;
      offset += length;
    }
    if (!firstPage || !lastPage) throw new Error("Cached Ogg chunk contains no pages");

    if (isFirstChunk) {
      this.initialSerial = getSerial(firstPage);
    }
    this.firstChunkHeaderDone = true;
    this.nextSequence = getSequence(lastPage);
    this.cumulativeGranule = getGranule(lastPage);
    this.chunkMaxGranule = 0n;
  }
}

/**
 * Extracts just the leading OpusHead+OpusTags pages from an already-cached,
 * already-stitched chunk 0 buffer. Used to inject the stream's only header
 * into a response that would otherwise start beyond it (a `?t=` resume
 * landing past chunk 0) — without it, the receiving player has no way to
 * identify the stream's format at all.
 */
export function extractHeaderPages(chunk0Buffer: Buffer): Buffer {
  const headerPages: Buffer[] = [];
  let offset = 0;
  while (offset < chunk0Buffer.length) {
    const length = readPageLength(chunk0Buffer, offset);
    if (length === null) throw new Error("Chunk 0 buffer is truncated");
    const page = chunk0Buffer.subarray(offset, offset + length);
    if (!isMagicAt(page, OPUS_HEAD_MAGIC) && !isMagicAt(page, OPUS_TAGS_MAGIC)) break;
    headerPages.push(page);
    offset += length;
  }
  return Buffer.concat(headerPages);
}
