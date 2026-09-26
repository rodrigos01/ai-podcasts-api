// ADTS (Audio Data Transport Stream) framing for the raw AAC our PCM->AAC
// encoder (utils/aacEncoder.ts) produces from Cloud TTS's PCM output. Unlike
// Ogg Opus, ADTS has no shared "logical stream" header or serial-number
// concept at all — every frame is fully self-delimited by its own 7-byte
// (or 9-byte, with CRC) header carrying its own length, so independently
// -encoded chunks concatenate directly into one playable resource with no
// rewriting/stitching step required (contrast utils/oggStitch.ts, which this
// module has no equivalent of).
//
// This only needs to (a) reassemble frames out of ffmpeg's own stdout
// chunks, which don't align to frame boundaries any more than Cloud TTS's
// gRPC deltas aligned to Ogg page boundaries, and (b) derive a chunk's audio
// duration from its frame count, for `?t=` resume and `generatedAudioSeconds`
// bookkeeping — both driven by counting frames rather than any encoder
// bitrate assumption, so they're correct regardless of how ffmpeg's AAC
// encoder varies frame size internally (confirmed empirically: frame sizes
// are not constant even at a fixed target bitrate).
//
// Assumes AAC-LC's standard 1024 samples/frame — confirmed against real
// ffmpeg ("aac" encoder) output on 2026-09-26 (48 frames for ~2.048s of
// audio at 24000 Hz: 48 * 1024 / 24000 = 2.048). Re-verify if the encoder
// or its configuration ever changes.
const SAMPLES_PER_FRAME = 1024;

/**
 * Returns the byte length of the ADTS frame starting at `offset` (header
 * included), or null if `buffer` doesn't yet contain the whole frame (more
 * bytes needed — used by AdtsFrameAccumulator to know when to wait for the
 * next delta). Throws if `offset` isn't the start of a valid frame at all,
 * since our input is always either our own encoder's output consumed via
 * our own frame-aligned advancement, or a previously-written cache file —
 * a mismatch here means a real bug, not a resync-able transport glitch.
 */
function readAdtsFrameLength(buffer: Buffer, offset: number): number | null {
  if (offset + 7 > buffer.length) return null;
  if (buffer[offset] !== 0xff || (buffer[offset + 1]! & 0xf0) !== 0xf0) {
    throw new Error(`Expected ADTS sync word at offset ${offset}`);
  }
  const protectionAbsent = buffer[offset + 1]! & 0x01;
  const headerLength = protectionAbsent ? 7 : 9;
  if (offset + headerLength > buffer.length) return null;
  const frameLength =
    ((buffer[offset + 3]! & 0x03) << 11) | (buffer[offset + 4]! << 3) | ((buffer[offset + 5]! & 0xe0) >> 5);
  if (offset + frameLength > buffer.length) return null;
  return frameLength;
}

/**
 * Incrementally extracts complete ADTS frames from a series of arbitrary
 * byte fragments (ffmpeg's stdout deltas don't align to frame boundaries).
 * Scoped to a single chunk's encoding — create a fresh instance per chunk.
 */
export class AdtsFrameAccumulator {
  private leftover: Buffer = Buffer.alloc(0);

  /** Feeds one more delta; returns however many complete frames are now available (possibly none). */
  push(delta: Buffer): Buffer[] {
    this.leftover = this.leftover.length > 0 ? Buffer.concat([this.leftover, delta]) : delta;

    const frames: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const length = readAdtsFrameLength(this.leftover, offset);
      if (length === null) break;
      frames.push(this.leftover.subarray(offset, offset + length));
      offset += length;
    }
    this.leftover = offset > 0 ? Buffer.from(this.leftover.subarray(offset)) : this.leftover;
    return frames;
  }

  /** Call once a chunk's encoder has finished — throws if a partial frame was never completed. */
  assertDrained(): void {
    if (this.leftover.length > 0) {
      throw new Error(
        `AAC stream ended with an incomplete ADTS frame (${this.leftover.length} leftover bytes)`,
      );
    }
  }
}

/** Number of complete ADTS frames in an already-framed buffer (e.g. a cached chunk). */
export function countAdtsFrames(buffer: Buffer): number {
  let offset = 0;
  let count = 0;
  while (offset < buffer.length) {
    const length = readAdtsFrameLength(buffer, offset);
    if (length === null) throw new Error("Truncated ADTS stream while counting frames");
    offset += length;
    count++;
  }
  return count;
}

/**
 * A chunk's audio duration, derived from its own frame count — unlike Ogg
 * Opus's granule position, ADTS frames carry no timestamp at all, so this is
 * the only way to know a chunk's duration. Each cached chunk is independent
 * (no absolute/cross-chunk position baked in, since nothing here rewrites
 * chunks the way oggStitch.ts did) — callers needing an episode-wide
 * cumulative total (audio.service.ts) sum this across chunks themselves.
 */
export function getAdtsDurationSeconds(buffer: Buffer, sampleRateHertz: number): number {
  return (countAdtsFrames(buffer) * SAMPLES_PER_FRAME) / sampleRateHertz;
}

/**
 * Resolves a saved playback position (seconds) into the byte offset of the
 * nearest ADTS frame boundary at-or-before that time, across the whole
 * episode's cached chunks. Unlike the old Ogg Opus resume (chunk-boundary
 * granularity only, a consequence of chunks being chained sub-streams), each
 * AAC chunk here is independently decodable, so this walks individual
 * frames for genuine sub-chunk precision. Stops (and resumes generation from
 * there) at the first not-yet-cached chunk, same as the implicit behavior
 * when no time is requested at all.
 */
export async function resolveTimeToByteOffset(
  startTimeSeconds: number,
  sampleRateHertz: number,
  chunkCount: number,
  cachedSizeAt: (index: number) => number | null,
  fetchCachedBytes: (index: number) => Promise<Buffer | null>,
): Promise<number> {
  const frameDurationSeconds = SAMPLES_PER_FRAME / sampleRateHertz;
  let byteOffset = 0;
  let elapsedSeconds = 0;

  for (let index = 0; index < chunkCount; index++) {
    const size = cachedSizeAt(index);
    if (size === null) return byteOffset;
    const bytes = await fetchCachedBytes(index);
    if (!bytes) return byteOffset;

    let offset = 0;
    for (;;) {
      const length = readAdtsFrameLength(bytes, offset);
      if (length === null) break;
      // This frame's end would pass the target time — stop at its start
      // rather than consuming it, so resume never lands past where the
      // listener was.
      if (elapsedSeconds + frameDurationSeconds > startTimeSeconds) return byteOffset;
      offset += length;
      byteOffset += length;
      elapsedSeconds += frameDurationSeconds;
    }
  }
  return byteOffset;
}
