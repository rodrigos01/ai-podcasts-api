import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import type { Episode } from "../src/schemas/episode.schema";
import type { Podcast } from "../src/schemas/podcast.schema";
import { buildStreamingWavHeader, DEFAULT_PCM_FORMAT } from "../src/utils/wav";

// Mock dependencies
vi.mock("../src/storage/audioCache.repository", () => ({
  createFinalAudioReadStream: vi.fn(),
  getCachedChunk: vi.fn(),
  getCachedChunkSize: vi.fn(),
  getFinalAudioSize: vi.fn(),
  putCachedChunk: vi.fn(),
}));

vi.mock("../src/data/audioLock.repository", () => ({
  tryAcquireChunkLock: vi.fn(),
  releaseChunkLock: vi.fn(),
}));

vi.mock("../src/data/episode.repository", () => ({
  bumpGeneratedAudioSeconds: vi.fn(),
}));

vi.mock("../src/services/episodeGeneration/audioFinalize.service", () => ({
  finalizeEpisodeAudio: vi.fn(),
}));

vi.mock("../src/services/episodeGeneration/voiceResolution.service", () => ({
  resolveHostVoice: vi.fn().mockResolvedValue({ voiceId: "v1", languageCode: "en-US" }),
  resolveGuestVoice: vi.fn().mockResolvedValue({ voiceId: "v2", languageCode: "en-US" }),
}));

vi.mock("../src/llm/ttsClient", () => ({
  streamEpisodeSynthesis: vi.fn(),
  designVoice: vi.fn().mockResolvedValue("mock-voice-id"),
}));

import * as audioCache from "../src/storage/audioCache.repository";
import * as audioLock from "../src/data/audioLock.repository";
import * as ttsClient from "../src/llm/ttsClient";
import { streamEpisodeAudio } from "../src/services/audio.service";

function createMockResponse(): Response & {
  headers: Record<string, string>;
  statusCode: number;
  written: Buffer[];
} {
  const emitter = new EventEmitter() as any;
  emitter.headers = {};
  emitter.statusCode = 200;
  emitter.written = [];
  emitter.destroyed = false;
  emitter.writableEnded = false;

  emitter.set = vi.fn((key: string, val: string) => {
    emitter.headers[key.toLowerCase()] = val;
  });
  emitter.removeHeader = vi.fn((key: string) => {
    delete emitter.headers[key.toLowerCase()];
  });
  emitter.status = vi.fn((code: number) => {
    emitter.statusCode = code;
    return emitter;
  });
  emitter.write = vi.fn((chunk: Buffer) => {
    emitter.written.push(chunk);
    return true;
  });
  emitter.end = vi.fn(() => {
    emitter.writableEnded = true;
  });

  return emitter;
}

const mockPodcast: Podcast = {
  id: "pod-1",
  title: "Test Podcast",
  description: "Tech podcast",
  structure: "Two hosts discussing tech",
  hosts: [
    {
      id: "h1",
      name: "Alice",
      voice: "VoiceA",
      persona: "Host 1",
      accent: undefined,
      resolvedVoiceId: "v1",
      resolvedVoiceOrigin: "design",
      resolvedVoiceHash: "h1",
    },
    {
      id: "h2",
      name: "Bob",
      voice: "VoiceB",
      persona: "Host 2",
      accent: undefined,
      resolvedVoiceId: "v2",
      resolvedVoiceOrigin: "design",
      resolvedVoiceHash: "h2",
    },
  ],
  ownerId: "u1",
  createdAt: 1000,
  updatedAt: 1000,
};

const mockEpisode: Episode = {
  id: "ep-1",
  title: "Episode 1",
  topics: "Tech",
  length: "short",
  sourceIds: [],
  participantHostIds: ["h1", "h2"],
  guests: [],
  productionNotes: "Notes",
  status: "streamable",
  progress: null,
  transcript: "Alice: Line 1\n\nBob: Line 2",
  ttsChunks: [
    {
      index: 0,
      startTurnIndex: 0,
      endTurnIndex: 1,
      startOffset: 0,
      endOffset: 13,
      turnCount: 1,
    },
    {
      index: 1,
      startTurnIndex: 1,
      endTurnIndex: 2,
      startOffset: 15,
      endOffset: 26,
      turnCount: 1,
    },
  ],
  generatedAudioSeconds: 0,
  condensedSummaries: null,
  error: null,
  createdAt: 1000,
  updatedAt: 1000,
};

describe("streamEpisodeAudio with chunking and seeking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(audioCache.getFinalAudioSize).mockResolvedValue(null);
  });

  it("serves all cached chunks with 200 OK and streaming header for fresh request", async () => {
    const chunk0Pcm = Buffer.alloc(48000, 1); // 1 second
    const chunk1Pcm = Buffer.alloc(48000, 2); // 1 second

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm.length : chunk1Pcm.length;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm : chunk1Pcm;
    });

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: null,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/wav");
    expect(res.headers["content-length"]).toBe(String(44 + 96000));
    expect(res.written).toHaveLength(3); // header + chunk0 + chunk1
    expect(res.written[0]?.length).toBe(44); // WAV header
    expect(res.written[0]?.readUInt32LE(40)).toBe(96000); // exact data size, not 0xFFFFFFFF
    expect(res.written[1]).toEqual(chunk0Pcm);
    expect(res.written[2]).toEqual(chunk1Pcm);
    expect(res.writableEnded).toBe(true);
  });

  it("seeks with ?t=1.0 into cached chunks and skips chunk 0", async () => {
    const chunk0Pcm = Buffer.alloc(48000, 1); // 1.0 second (48000 bytes)
    const chunk1Pcm = Buffer.alloc(48000, 2); // 1.0 second

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm.length : chunk1Pcm.length;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm : chunk1Pcm;
    });

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: 1.0, // seek to 1 second (skips chunk 0 entirely)
    });

    expect(res.statusCode).toBe(200);
    // Content-Length = fullResourceLength - targetOffset = (44 + 96000) - 48000 = 48044
    expect(res.headers["content-length"]).toBe(String(48044));
    expect(res.written).toHaveLength(2); // header + chunk1 only
    expect(res.written[0]?.length).toBe(44);
    expect(res.written[0]?.readUInt32LE(40)).toBe(48000); // exact remaining data size
    expect(res.written[1]).toEqual(chunk1Pcm);
    expect(res.writableEnded).toBe(true);
  });

  it("seamlessly transitions from cached chunk 0 to live-generating chunk 1", async () => {
    const chunk0Pcm = Buffer.alloc(48000, 1); // cached
    const chunk1Delta1 = Buffer.alloc(24000, 2); // live delta 1
    const chunk1Delta2 = Buffer.alloc(24000, 3); // live delta 2

    // Chunk 0 is cached; chunk 1 is not
    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm.length : null;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm : null;
    });

    vi.mocked(audioLock.tryAcquireChunkLock).mockResolvedValue(true);

    vi.mocked(ttsClient.streamEpisodeSynthesis).mockImplementation(
      async (_turns, _voices, onDelta) => {
        onDelta(chunk1Delta1);
        onDelta(chunk1Delta2);
      },
    );

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: null,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/wav");
    expect(res.headers["content-length"]).toBeUndefined(); // Never return Content-Length while chunks are generating!

    // Written buffers:
    // 0: WAV header (44 bytes)
    // 1: chunk0Pcm from cache (48000 bytes)
    // 2: chunk1Delta1 from live TTS (24000 bytes)
    // 3: chunk1Delta2 from live TTS (24000 bytes)
    expect(res.written).toHaveLength(4);
    expect(res.written[0]?.length).toBe(44);
    expect(res.written[1]).toEqual(chunk0Pcm);
    expect(res.written[2]).toEqual(chunk1Delta1);
    expect(res.written[3]).toEqual(chunk1Delta2);

    // Verify chunk 1 was saved to cache
    expect(audioCache.putCachedChunk).toHaveBeenCalledWith(
      mockPodcast.id,
      mockEpisode.id,
      1,
      Buffer.concat([chunk1Delta1, chunk1Delta2]),
    );

    expect(audioLock.releaseChunkLock).toHaveBeenCalledWith(mockPodcast.id, mockEpisode.id, 1);
    expect(res.writableEnded).toBe(true);
  });

  it("honors Range: bytes=44- on fully cached audio with 206 Partial Content", async () => {
    const chunk0Pcm = Buffer.alloc(48000, 1);
    const chunk1Pcm = Buffer.alloc(48000, 2);

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm.length : chunk1Pcm.length;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm : chunk1Pcm;
    });

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: 44, // start right after the 44-byte WAV header
      startTimeSeconds: null,
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 44-${44 + 96000 - 1}/${44 + 96000}`);
    expect(res.headers["content-length"]).toBe(String(96000));
    // Header should NOT be written for Range request past byte 44
    expect(res.written).toHaveLength(2);
    expect(res.written[0]).toEqual(chunk0Pcm);
    expect(res.written[1]).toEqual(chunk1Pcm);
    expect(res.writableEnded).toBe(true);
  });

  it("honors Range: bytes=0- on fully cached audio with 206 Partial Content and exact WAV header", async () => {
    const chunk0Pcm = Buffer.alloc(48000, 1);
    const chunk1Pcm = Buffer.alloc(48000, 2);

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm.length : chunk1Pcm.length;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Pcm : chunk1Pcm;
    });

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: 0,
      startTimeSeconds: null,
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-${44 + 96000 - 1}/${44 + 96000}`);
    expect(res.headers["content-length"]).toBe(String(44 + 96000));
    expect(res.written).toHaveLength(3); // exact header + chunk0 + chunk1
    expect(res.written[0]?.length).toBe(44);
    expect(res.written[0]?.readUInt32LE(40)).toBe(96000); // exact data size, NOT 0xFFFFFFFF
    expect(res.written[1]).toEqual(chunk0Pcm);
    expect(res.written[2]).toEqual(chunk1Pcm);
    expect(res.writableEnded).toBe(true);
  });
});

