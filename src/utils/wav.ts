// WAV/PCM utilities — reintroduced for the Gemini 3.8 Flash TTS migration.
// The old Cloud TTS pipeline deleted this module's predecessor when it
// switched to Ogg Opus (2026-09-16) specifically for Opus's ~10-16x size
// win over raw PCM. The new model has no compressed streaming output at
// all (WAV/raw PCM, mulaw, alaw only — see AGENTS.md), so the pipeline is
// back to caching WAV while an episode's audio is being generated, only
// encoding to Ogg Opus once via a real `ffmpeg` pass after the fact (see
// audioFinalize.service.ts). WAV's one real advantage for the in-progress
// case is what motivates bringing this back: a fixed bytes-per-second
// relationship, so `secondsToByteOffset` below is exact — no chunk-boundary
// approximation needed the way Opus required (utils/oggOpus.ts, deleted).

export interface WavFormat {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

// Gemini 3.8 Flash TTS's confirmed streaming default (audio/l16, 24kHz,
// mono, 16-bit signed little-endian PCM) — see llm/ttsClient.ts. Used
// whenever a delta event doesn't carry its own channel/sample-rate
// metadata.
export const DEFAULT_PCM_FORMAT: WavFormat = {
  numChannels: 1,
  sampleRate: 24000,
  bitsPerSample: 16,
};

// Placeholder for a WAV file whose total length isn't known yet (a live,
// still-growing stream). There are two competing real-world conventions for
// this and neither is universally honored — confirmed live against two
// different failure modes, in this order:
//   - 0xFFFFFFFF (the largest value that fits the 32-bit size field) is what
//     ffmpeg/sox use when piping WAV to a non-seekable output. Confirmed
//     live (2026-09-24) that at least one real player (a mobile client's
//     ExoPlayer) doesn't special-case it as "unknown," and just computes a
//     literal (enormous, wrong) duration from it: 0xFFFFFFFF bytes at this
//     format's 48000 bytes/sec byte rate is exactly 1491m18s, which is what
//     showed up as the episode's total duration in testing.
//   - 0 was tried next (2026-09-24) on the theory that it's the convention
//     some recording software uses instead, patching in the real size once
//     a write finishes. Confirmed live (2026-09-25) that this is *worse*: a
//     declared data-chunk size of 0 is taken literally by more than one
//     real player as "zero bytes of audio, nothing to play" — playback
//     never starts at all, for every episode hitting the live-generation
//     path (final.ogg's fast path is unaffected, since that's a real,
//     correctly-sized file). A wrong displayed duration is a much smaller
//     problem than audio that never starts, so this reverts to 0xFFFFFFFF.
//     If a genuinely universal fix is wanted later, it likely means not
//     relying on the RIFF header's declared size at all for the streaming
//     case (e.g. a container/transport that doesn't encode length in-band),
//     not a third placeholder value — don't try a third magic number here
//     without first confirming it against real players, plural.
const UNKNOWN_LENGTH_PLACEHOLDER = 0xffffffff;

function writeWavHeader(header: Buffer, fmt: WavFormat, dataLength: number): void {
  const byteRate = fmt.sampleRate * fmt.numChannels * (fmt.bitsPerSample / 8);
  const blockAlign = fmt.numChannels * (fmt.bitsPerSample / 8);
  const riffChunkSize = dataLength === UNKNOWN_LENGTH_PLACEHOLDER ? UNKNOWN_LENGTH_PLACEHOLDER : 36 + dataLength;
  header.write("RIFF", 0);
  header.writeUInt32LE(riffChunkSize >>> 0, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(fmt.numChannels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength >>> 0, 40);
}

/** A complete, correctly-sized WAV header+data buffer for `pcm`. */
export function buildWav(fmt: WavFormat, pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  writeWavHeader(header, fmt, pcm.length);
  return Buffer.concat([header, pcm]);
}

/**
 * A 44-byte WAV header alone declaring the exact `dataLength` (in bytes).
 * Used when the total PCM length is known (e.g. all chunks cached or fixed-length range).
 */
export function buildWavHeader(fmt: WavFormat, dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  writeWavHeader(header, fmt, dataLength);
  return header;
}

/**
 * A 44-byte header alone, declaring an unknown/maximal total length —
 * written once, up front, before any PCM is available, so a live HTTP
 * response can start streaming immediately (see audio.service.ts). Not
 * meant to be trusted as the resource's real size by anything downstream;
 * once generation completes the *cached* WAV is rebuilt from scratch via
 * `buildWav` with the real length.
 */
export function buildStreamingWavHeader(fmt: WavFormat): Buffer {
  const header = Buffer.alloc(44);
  writeWavHeader(header, fmt, UNKNOWN_LENGTH_PLACEHOLDER);
  return header;
}


/** Parses a RIFF/WAVE buffer into its format and raw PCM data. */
export function extractPcm(buffer: Buffer): { fmt: WavFormat; pcm: Buffer } {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE buffer");
  }
  let offset = 12;
  let fmt: WavFormat | null = null;
  let pcm: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      fmt = {
        numChannels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
      offset = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
    } else if (chunkId === "data") {
      // `data`'s declared size can't be trusted — a streaming/in-progress
      // header (see buildStreamingWavHeader) declares a placeholder
      // (UNKNOWN_LENGTH_PLACEHOLDER) that's stale by the time real PCM
      // bytes have been appended after it, in either direction (the
      // current 0xFFFFFFFF convention undersells it; the briefly-tried 0
      // convention oversold it). `data` is always the last chunk in every
      // WAV this app writes (buildWav/buildStreamingWavHeader never add
      // anything after it), so the robust read is simply "everything left
      // in the buffer," not the declared size in either direction — this
      // also means a future change to the placeholder value doesn't need a
      // matching change here.
      pcm = buffer.subarray(body);
      break;
    } else {
      offset = body + chunkSize + (chunkSize % 2);
    }
  }
  if (!fmt) throw new Error("No fmt chunk found in WAV");
  if (!pcm) throw new Error("No data chunk found in WAV");
  return { fmt, pcm };
}

/** Real audio duration, in seconds, of `pcmLength` bytes of `fmt`-shaped PCM. */
export function durationSeconds(fmt: WavFormat, pcmLength: number): number {
  const bytesPerSecond = fmt.sampleRate * fmt.numChannels * (fmt.bitsPerSample / 8);
  return bytesPerSecond > 0 ? pcmLength / bytesPerSecond : 0;
}

/**
 * The exact PCM-data byte offset corresponding to `seconds` into a `fmt`-
 * shaped stream — WAV's fixed bytes-per-second relationship makes this
 * exact, unlike Ogg Opus's chunk-boundary-only `resolveTimeToByteOffset`
 * (deleted utils/oggOpus.ts). Callers add the 44-byte header length
 * themselves if working in full-resource (header + data) byte space.
 */
export function secondsToByteOffset(fmt: WavFormat, seconds: number): number {
  const bytesPerSecond = fmt.sampleRate * fmt.numChannels * (fmt.bitsPerSample / 8);
  const blockAlign = fmt.numChannels * (fmt.bitsPerSample / 8);
  const rawOffset = Math.max(0, Math.floor(seconds * bytesPerSecond));
  // Keep the offset aligned to a whole sample frame so a client never lands
  // mid-sample.
  return rawOffset - (rawOffset % blockAlign);
}
