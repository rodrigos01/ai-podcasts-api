import { spawn } from "node:child_process";

const SAMPLING_FREQUENCIES: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export interface AacStreamEncoder {
  write(pcmDelta: Buffer): void;
  end(): Promise<Buffer>;
  destroy(err?: Error): void;
}

/**
 * Creates a real-time streaming AAC encoder using ffmpeg with `-flush_packets 1`.
 * Each time a PCM delta is written, ADTS AAC frames are emitted immediately to `onAacDelta`
 * without waiting for the full stream/chunk to finish.
 */
export function createAacStreamEncoder(
  onAacDelta: (aacDelta: Buffer) => void,
  sampleRate: number = 24000,
  bitrateKbps: number = 64,
): AacStreamEncoder {
  const ffmpeg = spawn("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    String(sampleRate),
    "-ac",
    "1",
    "-i",
    "pipe:0",
    "-c:a",
    "aac",
    "-b:a",
    `${bitrateKbps}k`,
    "-flush_packets",
    "1",
    "-f",
    "adts",
    "pipe:1",
  ]);

  const aacChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  ffmpeg.stdout.on("data", (chunk: Buffer) => {
    aacChunks.push(chunk);
    try {
      onAacDelta(chunk);
    } catch (err) {
      console.error("Error in onAacDelta callback:", err);
    }
  });

  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const closedPromise = new Promise<Buffer>((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(aacChunks));
      } else {
        const stderrMsg = Buffer.concat(stderrChunks).toString("utf8");
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrMsg}`));
      }
    });
  });

  return {
    write(pcmDelta: Buffer) {
      if (!ffmpeg.stdin.destroyed) {
        ffmpeg.stdin.write(pcmDelta);
      }
    },
    end(): Promise<Buffer> {
      if (!ffmpeg.stdin.destroyed) {
        ffmpeg.stdin.end();
      }
      return closedPromise;
    },
    destroy() {
      ffmpeg.kill("SIGKILL");
    },
  };
}

/**
 * Encodes 16-bit mono raw PCM to ADTS AAC using ffmpeg.
 * ADTS (Audio Data Transport Stream) frames are self-contained and concatenable.
 */
export async function encodePcmToAac(
  pcm: Buffer,
  sampleRate: number = 24000,
  bitrateKbps: number = 64,
): Promise<Buffer> {
  const encoder = createAacStreamEncoder(() => {}, sampleRate, bitrateKbps);
  encoder.write(pcm);
  return encoder.end();
}

/**
 * Parses ADTS frame headers in a buffer and computes total audio duration in seconds.
 * Each AAC-LC frame contains 1024 audio samples.
 */
export function getAdtsDurationSeconds(buffer: Buffer, fallbackSampleRate: number = 24000): number {
  let offset = 0;
  let totalSamples = 0;

  while (offset + 7 <= buffer.length) {
    // Syncword: 12 bits 0xFFF
    if (buffer[offset] !== 0xff || (buffer[offset + 1]! & 0xf0) !== 0xf0) {
      offset++;
      continue;
    }

    const freqIndex = (buffer[offset + 2]! & 0x3c) >> 2;
    const sampleRate = SAMPLING_FREQUENCIES[freqIndex] ?? fallbackSampleRate;

    const frameLength =
      ((buffer[offset + 3]! & 0x03) << 11) |
      (buffer[offset + 4]! << 3) |
      ((buffer[offset + 5]! & 0xe0) >> 5);

    if (frameLength < 7 || offset + frameLength > buffer.length) {
      break;
    }

    totalSamples += 1024;
    offset += frameLength;
  }

  return totalSamples / fallbackSampleRate;
}

/**
 * Creates a synthetic minimal ADTS frame for testing without needing ffmpeg.
 * Produces a valid 7-byte header followed by `payloadLength` zero bytes.
 */
export function createMockAdtsFrame(
  payloadLength: number = 100,
  sampleRateIndex: number = 6, // 24000 Hz
): Buffer {
  const frameLength = 7 + payloadLength;
  const header = Buffer.alloc(7);

  // Syncword 0xFFF + MPEG-4 (0) + Layer (00) + Protection absent (1) => 0xFFF1
  header[0] = 0xff;
  header[1] = 0xf1;
  // Profile AAC-LC (1) << 6 | freqIndex << 2 | private (0) | channel mono (1) >> 2 => 0x40 | (freqIndex << 2) | 0
  header[2] = 0x40 | ((sampleRateIndex & 0x0f) << 2);
  // Channel mono lower 2 bits (01 << 6) | original (0) | home (0) | copyright (0) | copyright id (0) | frame len high 2 bits
  header[3] = (1 << 6) | ((frameLength >> 11) & 0x03);
  // Frame len middle 8 bits
  header[4] = (frameLength >> 3) & 0xff;
  // Frame len low 3 bits | buffer fullness high 5 bits
  header[5] = ((frameLength & 0x07) << 5) | 0x1f;
  // Buffer fullness low 6 bits | number of raw data blocks (0)
  header[6] = 0xfc;

  return Buffer.concat([header, Buffer.alloc(payloadLength)]);
}
