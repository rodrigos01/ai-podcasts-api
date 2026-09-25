import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import type { Episode } from "../src/schemas/episode.schema";
import type { Podcast } from "../src/schemas/podcast.schema";

// Mock dependencies
vi.mock("../src/storage/audioCache.repository", () => ({
  getCachedChunk: vi.fn(),
  getCachedChunkSize: vi.fn(),
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

vi.mock("../src/utils/aac", () => ({
  createAacStreamEncoder: vi.fn((onDelta: (buf: Buffer) => void) => {
    const written: Buffer[] = [];
    return {
      write: vi.fn((pcm: Buffer) => {
        const aac = Buffer.alloc(Math.max(10, Math.floor(pcm.length / 6)));
        written.push(aac);
        onDelta(aac);
      }),
      end: vi.fn(async () => Buffer.concat(written)),
      destroy: vi.fn(),
    };
  }),
  encodePcmToAac: vi.fn(async (pcm: Buffer) => {
    return Buffer.alloc(Math.max(100, Math.floor(pcm.length / 6)));
  }),
  getAdtsDurationSeconds: vi.fn((buf: Buffer) => {
    return buf.length / 8000;
  }),
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

describe("streamEpisodeAudio with AAC chunking and seeking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves all cached chunks with 200 OK and audio/aac for fresh request", async () => {
    const chunk0Aac = Buffer.alloc(8000, 1); // 1 second
    const chunk1Aac = Buffer.alloc(8000, 2); // 1 second

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac.length : chunk1Aac.length;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac : chunk1Aac;
    });

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: null,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/aac");
    expect(res.headers["content-length"]).toBe(String(16000));
    expect(res.written).toHaveLength(2); // chunk0 + chunk1 (no container header)
    expect(res.written[0]).toEqual(chunk0Aac);
    expect(res.written[1]).toEqual(chunk1Aac);
    expect(res.writableEnded).toBe(true);
  });

  it("seeks with ?t=1.0 into cached chunks and skips chunk 0", async () => {
    const chunk0Aac = Buffer.alloc(8000, 1); // 1.0 second (8000 bytes)
    const chunk1Aac = Buffer.alloc(8000, 2); // 1.0 second

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac.length : chunk1Aac.length;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac : chunk1Aac;
    });

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: 1.0, // seek to 1 second (skips chunk 0 entirely)
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/aac");
    expect(res.headers["content-length"]).toBe(String(8000));
    expect(res.written).toHaveLength(1); // chunk1 only
    expect(res.written[0]).toEqual(chunk1Aac);
    expect(res.writableEnded).toBe(true);
  });

  it("seamlessly transitions from cached chunk 0 to live-generating chunk 1", async () => {
    const chunk0Aac = Buffer.alloc(8000, 1); // cached
    const chunk1Delta1 = Buffer.alloc(24000, 2); // live delta 1
    const chunk1Delta2 = Buffer.alloc(24000, 3); // live delta 2

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac.length : null;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac : null;
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
    expect(res.headers["content-type"]).toBe("audio/aac");
    expect(res.headers["content-length"]).toBeUndefined(); // Never return Content-Length while chunks are generating!

    // Written buffers: chunk0 (from cache) + chunk1Delta1 (real-time live) + chunk1Delta2 (real-time live)
    expect(res.written).toHaveLength(3);
    expect(res.written[0]).toEqual(chunk0Aac);
    expect(res.written[1]?.length).toBe(4000);
    expect(res.written[2]?.length).toBe(4000);

    // Verify chunk 1 was saved to cache
    expect(audioCache.putCachedChunk).toHaveBeenCalledWith(
      mockPodcast.id,
      mockEpisode.id,
      1,
      Buffer.concat([res.written[1]!, res.written[2]!]),
    );

    expect(audioLock.releaseChunkLock).toHaveBeenCalledWith(mockPodcast.id, mockEpisode.id, 1);
    expect(res.writableEnded).toBe(true);
  });

  it("honors Range: bytes=100- on fully cached audio with 206 Partial Content", async () => {
    const chunk0Aac = Buffer.alloc(8000, 1);
    const chunk1Aac = Buffer.alloc(8000, 2);

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac.length : chunk1Aac.length;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac : chunk1Aac;
    });

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: 100,
      startTimeSeconds: null,
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-type"]).toBe("audio/aac");
    expect(res.headers["content-range"]).toBe(`bytes 100-15999/16000`);
    expect(res.headers["content-length"]).toBe(String(15900));
    expect(res.written).toHaveLength(2);
    expect(res.written[0]).toEqual(chunk0Aac.subarray(100));
    expect(res.written[1]).toEqual(chunk1Aac);
    expect(res.writableEnded).toBe(true);
  });

  it("honors Range: bytes=0- on fully cached audio with 206 Partial Content", async () => {
    const chunk0Aac = Buffer.alloc(8000, 1);
    const chunk1Aac = Buffer.alloc(8000, 2);

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac.length : chunk1Aac.length;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac : chunk1Aac;
    });

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: 0,
      startTimeSeconds: null,
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-type"]).toBe("audio/aac");
    expect(res.headers["content-range"]).toBe(`bytes 0-15999/16000`);
    expect(res.headers["content-length"]).toBe(String(16000));
    expect(res.written).toHaveLength(2);
    expect(res.written[0]).toEqual(chunk0Aac);
    expect(res.written[1]).toEqual(chunk1Aac);
    expect(res.writableEnded).toBe(true);
  });
});
