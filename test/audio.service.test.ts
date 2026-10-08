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
  markAudioComplete: vi.fn(),
  getAudioEpoch: vi.fn().mockResolvedValue(0),
}));

vi.mock("../src/services/episodeGeneration/audioFinalize.service", () => ({
  finalizeEpisodeAudio: vi.fn(),
}));

vi.mock("../src/services/episodeGeneration/voiceResolution.service", () => ({
  resolveHostVoice: vi.fn().mockResolvedValue({ voiceId: "v1" }),
  resolveGuestVoice: vi.fn().mockResolvedValue({ voiceId: "v2" }),
  hasCurrentVoice: vi.fn(),
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
  sliceAdtsByTime: vi.fn((buf: Buffer, targetSeconds: number) => {
    const skipBytes = Math.min(buf.length, Math.floor(targetSeconds * 8000));
    return {
      buffer: buf.subarray(skipBytes),
      skippedSeconds: skipBytes / 8000,
      skippedBytes: skipBytes,
    };
  }),
}));

import * as audioCache from "../src/storage/audioCache.repository";
import * as audioLock from "../src/data/audioLock.repository";
import * as episodeRepo from "../src/data/episode.repository";
import * as ttsClient from "../src/llm/ttsClient";
import * as voiceResolution from "../src/services/episodeGeneration/voiceResolution.service";
import { streamEpisodeAudio } from "../src/services/audio.service";
import { AudioCancelledError } from "../src/utils/audioCancellation";

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
  emitter.destroy = vi.fn(() => {
    emitter.destroyed = true;
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
  error: null,
  createdAt: 1000,
  updatedAt: 1000,
};

describe("streamEpisodeAudio with AAC chunking and seeking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(episodeRepo.getAudioEpoch).mockResolvedValue(0);
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

  it("resolves no voices at all when every chunk is already cached", async () => {
    // Replaying a fully cached episode must not trigger a (slow, billed)
    // voice design just to hand an unused voice id to nothing — this is what
    // would otherwise happen on every first play of a pre-migration episode.
    const aac = Buffer.alloc(8000, 1);
    vi.mocked(audioCache.getCachedChunkSize).mockResolvedValue(aac.length);
    vi.mocked(audioCache.getCachedChunk).mockResolvedValue(aac);

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: null,
    });

    expect(res.writableEnded).toBe(true);
    expect(voiceResolution.resolveHostVoice).not.toHaveBeenCalled();
    expect(voiceResolution.resolveGuestVoice).not.toHaveBeenCalled();
  });

  describe("guest voice on a partly cached episode", () => {
    // Host Alice + guest Bob; chunk 0 cached, chunk 1 must be generated live.
    const guestEpisode: Episode = {
      ...mockEpisode,
      participantHostIds: ["h1"],
      guests: [
        {
          id: "g1",
          name: "Bob",
          voice: "VoiceB",
          persona: "Guest",
          accent: undefined,
          resolvedVoiceId: "stored-guest-voice",
          resolvedVoiceOrigin: "design",
          resolvedVoiceHash: null,
        },
      ],
    };

    async function streamWithOneUncachedChunk() {
      const chunk0Aac = Buffer.alloc(8000, 1);
      vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => (i === 0 ? chunk0Aac.length : null));
      vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => (i === 0 ? chunk0Aac : null));
      vi.mocked(audioLock.tryAcquireChunkLock).mockResolvedValue(true);
      vi.mocked(ttsClient.streamEpisodeSynthesis).mockImplementation(async (_turns, _voices, onDelta) => {
        onDelta(Buffer.alloc(24000, 2));
      });

      const res = createMockResponse();
      await streamEpisodeAudio(mockPodcast.id, guestEpisode.id, guestEpisode, mockPodcast, res, {
        rangeStart: null,
        startTimeSeconds: null,
      });
      return vi.mocked(ttsClient.streamEpisodeSynthesis).mock.calls[0]![1];
    }

    it("re-designs a stored guest voice that isn't current (e.g. from before the Enterprise move) instead of reusing it", async () => {
      vi.mocked(voiceResolution.hasCurrentVoice).mockReturnValue(false);

      const voices = await streamWithOneUncachedChunk();

      expect(voiceResolution.resolveGuestVoice).toHaveBeenCalledTimes(1);
      expect(voices.find((v) => v.label === "Bob")?.voiceId).toBe("v2");
      expect(voices.map((v) => v.voiceId)).not.toContain("stored-guest-voice");
    });

    it("reuses a stored guest voice that is current", async () => {
      vi.mocked(voiceResolution.hasCurrentVoice).mockReturnValue(true);

      const voices = await streamWithOneUncachedChunk();

      expect(voiceResolution.resolveGuestVoice).not.toHaveBeenCalled();
      expect(voices.find((v) => v.label === "Bob")?.voiceId).toBe("stored-guest-voice");
    });
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

  it("resumes from the exact mid-chunk time when ?t=SECONDS falls in the middle of a chunk", async () => {
    const chunk0Aac = Buffer.alloc(8000, 1); // 1.0 second
    const chunk1Aac = Buffer.alloc(8000, 2); // 1.0 second

    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac.length : chunk1Aac.length;
    });
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => {
      return i === 0 ? chunk0Aac : chunk1Aac;
    });

    const res = createMockResponse();
    // Seek to 0.5s (skips first 4000 bytes of chunk 0, sends remaining 4000 of chunk 0 + full 8000 of chunk 1)
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: 0.5,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/aac");
    // 4000 (from chunk 0) + 8000 (from chunk 1) = 12000
    expect(res.headers["content-length"]).toBe(String(12000));
    expect(res.written).toHaveLength(2);
    expect(res.written[0]?.length).toBe(4000);
    expect(res.written[1]).toEqual(chunk1Aac);
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
  it("applies Range on top of ?t= on cached audio (offsets are relative to the ?t= stream)", async () => {
    const chunk0Aac = Buffer.alloc(8000, 1); // 1.0 second
    const chunk1Aac = Buffer.alloc(8000, 2); // 1.0 second
    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => (i === 0 ? 8000 : 8000));
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => (i === 0 ? chunk0Aac : chunk1Aac));

    const res = createMockResponse();
    // ?t=0.5 -> stream is 4000 bytes of chunk 0 + 8000 of chunk 1 = 12000.
    // Range bytes=5000- is 5000 bytes into THAT stream: 1000 bytes into chunk 1.
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: 5000,
      startTimeSeconds: 0.5,
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 5000-11999/12000");
    expect(res.headers["content-length"]).toBe(String(7000));
    expect(Buffer.concat(res.written)).toEqual(chunk1Aac.subarray(1000));
  });

  it("rejects a Range past the end of the ?t= stream with 416 and the stream length", async () => {
    const chunk = Buffer.alloc(8000, 1);
    vi.mocked(audioCache.getCachedChunkSize).mockResolvedValue(chunk.length);
    vi.mocked(audioCache.getCachedChunk).mockResolvedValue(chunk);

    const res = createMockResponse();
    await expect(
      streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
        rangeStart: 12000,
        startTimeSeconds: 0.5,
      }),
    ).rejects.toMatchObject({ status: 416 });
    expect(res.headers["content-range"]).toBe("bytes */12000");
  });

  it("honors Range on the live path: 206, no Content-Length, first N bytes dropped", async () => {
    const chunk0Aac = Buffer.alloc(8000, 1); // cached
    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => (i === 0 ? chunk0Aac.length : null));
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => (i === 0 ? chunk0Aac : null));
    vi.mocked(audioLock.tryAcquireChunkLock).mockResolvedValue(true);
    vi.mocked(ttsClient.streamEpisodeSynthesis).mockImplementation(async (_turns, _voices, onDelta) => {
      onDelta(Buffer.alloc(24000, 2)); // -> 4000 AAC bytes (mock encoder)
      onDelta(Buffer.alloc(24000, 3)); // -> 4000 AAC bytes
    });

    const res = createMockResponse();
    // Skip all of cached chunk 0 plus 1000 bytes of the live chunk.
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: 9000,
      startTimeSeconds: null,
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-length"]).toBeUndefined();
    expect(Buffer.concat(res.written).length).toBe(8000 - 1000);
  });

  it("records audioComplete and the exact duration once the last chunk is generated", async () => {
    const chunk0Aac = Buffer.alloc(8000, 1); // 1.0s, cached
    const cached = new Map<number, Buffer>([[0, chunk0Aac]]);
    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => cached.get(i)?.length ?? null);
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => cached.get(i) ?? null);
    vi.mocked(audioCache.putCachedChunk).mockImplementation(async (_, __, i, data) => {
      cached.set(i, data);
    });
    vi.mocked(audioLock.tryAcquireChunkLock).mockResolvedValue(true);
    vi.mocked(ttsClient.streamEpisodeSynthesis).mockImplementation(async (_turns, _voices, onDelta) => {
      onDelta(Buffer.alloc(24000, 2)); // 4000 AAC bytes -> 0.5s
    });

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: null,
    });
    // Recorded before the response ends, not in the background after it.
    expect(episodeRepo.markAudioComplete).toHaveBeenCalledTimes(1);
    expect(episodeRepo.markAudioComplete).toHaveBeenCalledWith(mockPodcast.id, mockEpisode.id, 1.5);
    expect(vi.mocked(episodeRepo.markAudioComplete).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(res.end).mock.invocationCallOrder[0]!,
    );
  });

  it("does not record completion while chunks are still missing", async () => {
    vi.mocked(audioCache.getCachedChunkSize).mockImplementation(async (_, __, i) => (i === 0 ? 8000 : null));
    vi.mocked(audioCache.getCachedChunk).mockImplementation(async (_, __, i) => (i === 0 ? Buffer.alloc(8000, 1) : null));
    vi.mocked(audioLock.tryAcquireChunkLock).mockResolvedValue(true);
    vi.mocked(ttsClient.streamEpisodeSynthesis).mockImplementation(async (_turns, _voices, onDelta) => {
      onDelta(Buffer.alloc(24000, 2));
    });
    // Chunk 1 is generated but never lands in the (mocked) cache.
    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(episodeRepo.markAudioComplete).not.toHaveBeenCalled();
  });

  it("backfills completion for a fully cached episode that predates the flag", async () => {
    const chunk = Buffer.alloc(8000, 1);
    vi.mocked(audioCache.getCachedChunkSize).mockResolvedValue(chunk.length);
    vi.mocked(audioCache.getCachedChunk).mockResolvedValue(chunk);

    const res = createMockResponse();
    await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
      rangeStart: null,
      startTimeSeconds: null,
    });
    // Backfill happens before any bytes go out.
    expect(episodeRepo.markAudioComplete).toHaveBeenCalledWith(mockPodcast.id, mockEpisode.id, 2);
    expect(vi.mocked(episodeRepo.markAudioComplete).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(res.write).mock.invocationCallOrder[0]!,
    );
  });

  describe("when the episode's audio is cleared during generation", () => {
    function liveSetup() {
      vi.mocked(audioCache.getCachedChunkSize).mockResolvedValue(null);
      vi.mocked(audioCache.getCachedChunk).mockResolvedValue(null);
      vi.mocked(audioLock.tryAcquireChunkLock).mockResolvedValue(true);
    }

    it("does not start synthesizing for a request that began under an older epoch", async () => {
      liveSetup();
      vi.mocked(episodeRepo.getAudioEpoch).mockResolvedValue(1); // cleared since the request began (epoch 0)

      const res = createMockResponse();
      await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
        rangeStart: null,
        startTimeSeconds: null,
      });

      expect(ttsClient.streamEpisodeSynthesis).not.toHaveBeenCalled();
      expect(audioCache.putCachedChunk).not.toHaveBeenCalled();
      expect(res.destroy).toHaveBeenCalled();
    });

    it("drops the listener and caches nothing when synthesis is cancelled mid-chunk", async () => {
      liveSetup();
      // The epoch is unchanged while the chunk starts, then a clear lands during synthesis.
      vi.mocked(episodeRepo.getAudioEpoch).mockResolvedValueOnce(0).mockResolvedValue(1);
      vi.mocked(ttsClient.streamEpisodeSynthesis).mockImplementation(async (_turns, _voices, onDelta) => {
        onDelta(Buffer.alloc(24000, 2));
        throw new AudioCancelledError();
      });

      const res = createMockResponse();
      await streamEpisodeAudio(mockPodcast.id, mockEpisode.id, mockEpisode, mockPodcast, res, {
        rangeStart: null,
        startTimeSeconds: null,
      });

      expect(audioCache.putCachedChunk).not.toHaveBeenCalled();
      expect(audioLock.releaseChunkLock).toHaveBeenCalled();
      expect(res.destroy).toHaveBeenCalled();
    });
  });

});
