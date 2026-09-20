// Cloud TTS's `streamingSynthesize` returns fully self-contained Ogg Opus
// (RFC 7845/3533) per call — unlike raw PCM, there's no fixed bytes-per-
// second relationship, so resuming by a saved playback time (`?t=`) can no
// longer be done with simple arithmetic (see wav.ts's old
// secondsToByteOffset, removed with the PCM->OGG_OPUS migration). Instead we
// read each cached chunk's own final Ogg page and resume at the nearest
// chunk boundary at-or-before the requested time.
//
// Since audio.service.ts's oggStitch rewrite makes every cached chunk's
// granule positions absolute (continuous across the whole episode, not
// reset to 0 per chunk), a chunk's own last-page granule already *is* its
// cumulative end time — no need to sum durations chunk by chunk.

const CAPTURE_PATTERN = "OggS";
// Ogg Opus granule positions are always expressed in units of 1/48000s —
// fixed by the Opus spec, independent of the stream's actual sample rate.
const OPUS_GRANULE_RATE = 48000;

/**
 * Parses the last Ogg page in a buffer and returns the time in seconds
 * implied by its granule position — the same computation tools like
 * `opusinfo`/`ffprobe` use. Scans backward from the end of the buffer for a
 * page whose header + segment table + declared payload length lands exactly
 * on the end of the buffer, since the true final page must end there
 * (guards against the "OggS" capture pattern coincidentally appearing
 * inside compressed payload bytes).
 *
 * For a cached (already oggStitch-rewritten) chunk this is that chunk's
 * absolute cumulative end time, not a standalone duration — see
 * resolveTimeToByteOffset.
 */
export function getOggOpusDurationSeconds(buffer: Buffer): number {
  for (let offset = buffer.length - 27; offset >= 0; offset--) {
    if (buffer.toString("ascii", offset, offset + 4) !== CAPTURE_PATTERN) continue;
    if (buffer[offset + 4] !== 0) continue; // version, always 0

    const segmentCount = buffer[offset + 26];
    if (segmentCount === undefined) continue;
    const segmentTableStart = offset + 27;
    const segmentTableEnd = segmentTableStart + segmentCount;
    if (segmentTableEnd > buffer.length) continue;

    let payloadLength = 0;
    for (let i = segmentTableStart; i < segmentTableEnd; i++) {
      payloadLength += buffer[i] ?? 0;
    }
    if (segmentTableEnd + payloadLength !== buffer.length) continue;

    const granulePosition = buffer.readBigUInt64LE(offset + 6);
    return Number(granulePosition) / OPUS_GRANULE_RATE;
  }
  throw new Error("No valid Ogg page found while measuring Opus chunk duration");
}

/**
 * Resolves a saved playback position (seconds) into the byte offset of the
 * nearest chunk boundary at-or-before that time, walking cached chunks in
 * order and comparing each one's absolute cumulative end time (its own
 * last page's granule) against the target. Stops (and resumes generation
 * from there) at the first not-yet-cached chunk, same as the implicit
 * behavior when no time is requested at all. Chunk-boundary granularity
 * trades exact-second precision for correctness — a resumed stream starts
 * at most one chunk's length early, never skips ahead of where the
 * listener left off.
 */
export async function resolveTimeToByteOffset(
  startTimeSeconds: number,
  chunkCount: number,
  cachedSizeAt: (index: number) => number | null,
  fetchCachedBytes: (index: number) => Promise<Buffer | null>,
): Promise<number> {
  let byteOffset = 0;
  for (let index = 0; index < chunkCount; index++) {
    const size = cachedSizeAt(index);
    if (size === null) return byteOffset;
    const bytes = await fetchCachedBytes(index);
    if (!bytes) return byteOffset;
    const cumulativeEndSeconds = getOggOpusDurationSeconds(bytes);
    // The target time falls within this chunk — stop at its start rather
    // than consuming it, so resume never lands past where the listener was.
    if (cumulativeEndSeconds > startTimeSeconds) return byteOffset;
    byteOffset += size;
  }
  return byteOffset;
}
