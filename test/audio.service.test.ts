import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { streamEpisodeAudio } from "../src/services/audio.service";
import { getOggOpusDurationSeconds } from "../src/utils/oggOpus";

// In-memory fakes for the two storage boundaries — real GCS/Firestore are
// verified manually per this repo's testing philosophy (see AGENTS.md); what
// we want covered here is streamEpisodeAudio's own control flow (which
// chunks get fetched vs. generated, range/time-resume math, leader/follower
// handling), exercised against a *real* ffmpeg remux so the output is
// genuinely validated, not just assumed — including that it's actually a
// single, non-chained Ogg stream (the whole point of this remux — see
// oggRemux.ts), not just "some bytes that start with OggS".
const chunkStore = new Map<string, Buffer>();
const completeStore = new Map<string, Buffer>();
const chunkKey = (p: string, e: string, i: number) => `${p}:${e}:${i}`;

vi.mock("../src/storage/audioCache.repository", () => ({
  getCachedChunk: vi.fn(async (p: string, e: string, i: number) => chunkStore.get(chunkKey(p, e, i)) ?? null),
  getCachedChunkSize: vi.fn(
    async (p: string, e: string, i: number) => chunkStore.get(chunkKey(p, e, i))?.length ?? null,
  ),
  putCachedChunk: vi.fn(async (p: string, e: string, i: number, data: Buffer) => {
    chunkStore.set(chunkKey(p, e, i), data);
  }),
  getCachedCompleteOgg: vi.fn(async (p: string, e: string) => completeStore.get(`${p}:${e}`) ?? null),
  putCachedCompleteOgg: vi.fn(async (p: string, e: string, data: Buffer) => {
    completeStore.set(`${p}:${e}`, data);
  }),
}));

vi.mock("../src/data/audioLock.repository", () => ({
  tryAcquireChunkLock: vi.fn(async () => true),
  releaseChunkLock: vi.fn(async () => {}),
}));

// Queue of real Ogg Opus buffers consumed in call order — matches
// streamEpisodeAudio's sequential (not concurrent) per-chunk generation.
let pendingChunks: Buffer[] = [];
vi.mock("../src/llm/geminiClient", () => ({
  streamSpeech: vi.fn(
    async (
      _prompt: string,
      _turns: unknown[],
      _speakers: unknown[],
      onChunk: (b: Buffer) => void,
    ) => {
      const next = pendingChunks.shift();
      if (!next) throw new Error("no more fake TTS chunks queued");
      onChunk(next);
    },
  ),
}));

function genOggOpus(frequency: number, durationSeconds: number): Buffer {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=${durationSeconds}`,
    "-c:a",
    "libopus",
    "-f",
    "ogg",
    "pipe:1",
  ];
  return execFileSync(ffmpeg.path, args, { maxBuffer: 1024 * 1024 * 32 });
}

/**
 * Counts distinct logical Ogg streams (BOS pages / serial numbers) in a
 * buffer — this is the actual bug this remux exists to fix: ExoPlayer's
 * OggExtractor decodes a single logical stream fine but doesn't follow a
 * "chained" bitstream (multiple BOS'd streams concatenated) past the first
 * one. A correct response must always be exactly 1.
 */
function countLogicalOggStreams(data: Buffer): number {
  const serials = new Set<number>();
  let offset = 0;
  for (;;) {
    const idx = data.indexOf("OggS", offset, "ascii");
    if (idx === -1) break;
    const headerType = data[idx + 5];
    if (headerType !== undefined && (headerType & 0x02) !== 0) {
      serials.add(data.readUInt32LE(idx + 14));
    }
    offset = idx + 4;
  }
  return serials.size;
}

let chunkA: Buffer;
let chunkB: Buffer;

beforeAll(() => {
  chunkA = genOggOpus(440, 2);
  chunkB = genOggOpus(880, 2);
  // Sanity-check the fixture itself is genuinely chained (2 independent
  // logical streams) — otherwise countLogicalOggStreams' assertions below
  // wouldn't actually be testing anything.
  expect(countLogicalOggStreams(Buffer.concat([chunkA, chunkB]))).toBe(2);
});

afterEach(() => {
  chunkStore.clear();
  completeStore.clear();
  pendingChunks = [];
  vi.clearAllMocks();
});

/** Minimal fake Express Response capturing status/headers/body. */
class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  destroyed = false;
  writableEnded = false;

  status(code: number) {
    this.statusCode = code;
    return this;
  }
  set(name: string, value: string) {
    this.headers[name] = value;
    return this;
  }
  write(data: Buffer) {
    this.chunks.push(Buffer.from(data));
    return true;
  }
  end(data?: Buffer) {
    if (data) this.chunks.push(Buffer.from(data));
    this.writableEnded = true;
    return this;
  }
  body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function makeEpisode(chunkCount: number) {
  return {
    id: "ep1",
    title: "t",
    topics: "t",
    length: "short",
    sourceIds: [],
    participantHostIds: ["host1"],
    guests: [{ id: "guest1", name: "Guest One", voice: "en-US-Neural2-A", persona: "p" }],
    productionNotes: "n",
    status: "ready",
    progress: null,
    transcript: "Host One: hello there.\nGuest One: hi!\n".repeat(chunkCount),
    ttsPrompt: "prompt",
    ttsChunks: Array.from({ length: chunkCount }, (_, i) => ({
      index: i,
      startOffset: 0,
      endOffset: 10,
      estimatedTokens: 5,
    })),
    condensedSummaries: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  } as const;
}

function makePodcast() {
  return {
    id: "p1",
    title: "t",
    description: "d",
    structure: "s",
    hosts: [{ id: "host1", name: "Host One", voice: "en-US-Neural2-B", persona: "p" }],
    ownerId: "owner1",
    createdAt: 0,
    updatedAt: 0,
  } as const;
}

describe("streamEpisodeAudio", () => {
  it("generates missing chunks, relays a single non-chained Ogg stream live, and finalizes complete.ogg", async () => {
    pendingChunks = [chunkA, chunkB];
    const episode = makeEpisode(2);
    const podcast = makePodcast();
    const res = new FakeResponse();

    await streamEpisodeAudio("p1", "ep1", episode as never, podcast as never, res as never, {
      rangeStart: null,
      startTimeSeconds: null,
    });

    expect(res.headers["Content-Type"]).toBe("audio/ogg");
    expect(res.statusCode).toBe(200);
    expect(countLogicalOggStreams(res.body())).toBe(1);
    // Both chunks were generated and cached under their own Ogg Opus keys.
    expect(chunkStore.get(chunkKey("p1", "ep1", 0))).toEqual(chunkA);
    expect(chunkStore.get(chunkKey("p1", "ep1", 1))).toEqual(chunkB);

    // Finalization is fire-and-forget after the response completes.
    await vi.waitFor(() => expect(completeStore.get("p1:ep1")).toBeDefined());
    expect(countLogicalOggStreams(completeStore.get("p1:ep1")!)).toBe(1);
  });

  it("serves a fully-cached episode's complete.ogg with exact byte-range slicing", async () => {
    chunkStore.set(chunkKey("p1", "ep1", 0), chunkA);
    chunkStore.set(chunkKey("p1", "ep1", 1), chunkB);
    const episode = makeEpisode(2);
    const podcast = makePodcast();

    const full = new FakeResponse();
    await streamEpisodeAudio("p1", "ep1", episode as never, podcast as never, full as never, {
      rangeStart: null,
      startTimeSeconds: null,
    });
    expect(full.statusCode).toBe(200);
    const fullBody = full.body();
    expect(countLogicalOggStreams(fullBody)).toBe(1);
    expect(completeStore.get("p1:ep1")).toEqual(fullBody);

    const midpoint = Math.floor(fullBody.length / 2);
    const partial = new FakeResponse();
    await streamEpisodeAudio("p1", "ep1", episode as never, podcast as never, partial as never, {
      rangeStart: midpoint,
      startTimeSeconds: null,
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers["Content-Range"]).toBe(
      `bytes ${midpoint}-${fullBody.length - 1}/${fullBody.length}`,
    );
    expect(partial.body()).toEqual(fullBody.subarray(midpoint));
  });

  it("resolves a ?t= resume on a cached episode to a fresh single-stream Ogg starting at the requested chunk", async () => {
    chunkStore.set(chunkKey("p1", "ep1", 0), chunkA);
    chunkStore.set(chunkKey("p1", "ep1", 1), chunkB);
    const episode = makeEpisode(2);
    const podcast = makePodcast();

    // chunkA is ~2s — asking for t=3 should skip past it, landing on chunk 1.
    const res = new FakeResponse();
    await streamEpisodeAudio("p1", "ep1", episode as never, podcast as never, res as never, {
      rangeStart: null,
      startTimeSeconds: 3,
    });

    expect(res.statusCode).toBe(200);
    const body = res.body();
    expect(countLogicalOggStreams(body)).toBe(1);

    // The resumed stream should be its own fresh, self-contained resource
    // covering only chunk 1's ~2s — not the full ~4s episode.
    const remuxedChunk1Only = execFileSync(
      ffmpeg.path,
      ["-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0", "-c:a", "copy", "-f", "ogg", "pipe:1"],
      { input: chunkB, maxBuffer: 1024 * 1024 * 32 },
    );
    expect(body.length).toBeLessThan(remuxedChunk1Only.length + 200);
    expect(getOggOpusDurationSeconds(chunkB)).toBeCloseTo(2, 0);
  });
});
