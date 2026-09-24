import { describe, expect, it } from "vitest";
import {
  buildStreamingWavHeader,
  buildWav,
  DEFAULT_PCM_FORMAT,
  durationSeconds,
  extractPcm,
  secondsToByteOffset,
} from "../src/utils/wav";

const FMT = DEFAULT_PCM_FORMAT; // 1 channel, 24000 Hz, 16-bit

function pcmOfLength(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = i % 256;
  return buf;
}

describe("buildWav / extractPcm round trip", () => {
  it("round-trips format and PCM data exactly", () => {
    const pcm = pcmOfLength(2000);
    const wav = buildWav(FMT, pcm);
    const { fmt, pcm: extracted } = extractPcm(wav);
    expect(fmt).toEqual(FMT);
    expect(extracted).toEqual(pcm);
  });

  it("declares the real data length in the header", () => {
    const pcm = pcmOfLength(1234);
    const wav = buildWav(FMT, pcm);
    expect(wav.readUInt32LE(40)).toBe(1234);
    expect(wav.readUInt32LE(4)).toBe(36 + 1234);
    expect(wav.length).toBe(44 + 1234);
  });

  it("throws on a non-RIFF/WAVE buffer", () => {
    expect(() => extractPcm(Buffer.from("not a wav file at all"))).toThrow(/RIFF\/WAVE/);
  });
});

describe("buildStreamingWavHeader", () => {
  it("is a bare 44-byte header with no data yet", () => {
    const header = buildStreamingWavHeader(FMT);
    expect(header.length).toBe(44);
  });

  it("declares a placeholder size, not zero", () => {
    const header = buildStreamingWavHeader(FMT);
    expect(header.readUInt32LE(40)).toBe(0xffffffff);
    expect(header.readUInt32LE(4)).toBe(0xffffffff);
  });

  it("extractPcm clamps the declared length to what's actually appended so far", () => {
    const header = buildStreamingWavHeader(FMT);
    const pcm = pcmOfLength(500);
    const growing = Buffer.concat([header, pcm]);
    const { pcm: extracted } = extractPcm(growing);
    expect(extracted).toEqual(pcm);
  });
});

describe("durationSeconds", () => {
  it("computes exact duration from PCM byte length", () => {
    // 1 second of mono 16-bit 24kHz audio = 24000 * 1 * 2 bytes
    expect(durationSeconds(FMT, 48000)).toBe(1);
    expect(durationSeconds(FMT, 24000)).toBe(0.5);
  });

  it("returns 0 for a degenerate zero-rate format", () => {
    expect(durationSeconds({ numChannels: 0, sampleRate: 0, bitsPerSample: 16 }, 100)).toBe(0);
  });
});

describe("secondsToByteOffset", () => {
  it("is the exact inverse of durationSeconds for whole-second offsets", () => {
    expect(secondsToByteOffset(FMT, 1)).toBe(48000);
    expect(secondsToByteOffset(FMT, 2.5)).toBe(120000);
  });

  it("never returns a negative offset", () => {
    expect(secondsToByteOffset(FMT, -5)).toBe(0);
  });

  it("stays aligned to a whole sample frame", () => {
    const blockAlign = FMT.numChannels * (FMT.bitsPerSample / 8);
    const offset = secondsToByteOffset(FMT, 0.123456);
    expect(offset % blockAlign).toBe(0);
  });
});
