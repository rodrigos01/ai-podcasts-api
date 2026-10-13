import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage/audioCache.repository", () => ({
  getFinalAudioSignedUrl: vi.fn(),
  getFinalAudioSize: vi.fn(),
}));
vi.mock("../src/services/episodeGeneration/audioFinalize.service", () => ({
  finalizeEpisodeAudio: vi.fn(),
}));

import { resolveEpisodeAudioUrl } from "../src/services/audioUrl.service";
import { finalizeEpisodeAudio } from "../src/services/episodeGeneration/audioFinalize.service";
import { getFinalAudioSignedUrl, getFinalAudioSize } from "../src/storage/audioCache.repository";

const ORIGIN = "https://api.example.com";
const POD = "3f2b8c1e-9d4a-4e7b-8a61-0c5d2f9e7b34";
const EP = "a1b2c3d4-e5f6-4789-9abc-def012345678";
const SECRET = "test-secret-test-secret-test-secret";
const GCS = { url: "https://storage.googleapis.com/bucket/final.aac?X-Goog-Signature=abc", expiresAt: 1_800_021_600 };

const resolve = (audioComplete: boolean | undefined, status: "ready" | "streamable" = "ready") =>
  resolveEpisodeAudioUrl(ORIGIN, POD, EP, { audioComplete, status }, SECRET);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getFinalAudioSignedUrl).mockResolvedValue(GCS);
});

describe("resolveEpisodeAudioUrl", () => {
  it("hands out the /stream token URL while the audio is incomplete", async () => {
    for (const audioComplete of [false, undefined]) {
      const { url } = await resolve(audioComplete);
      expect(url).toMatch(/^https:\/\/api\.example\.com\/stream\/[A-Za-z0-9_-]{70}$/);
    }
    expect(getFinalAudioSize).not.toHaveBeenCalled();
  });

  it("hands out the /stream token URL for an episode still being written, even if audioComplete is set", async () => {
    // A stale flag (set early, before completion required "ready") must not produce a Storage URL
    // for a truncated file, nor consolidate one.
    vi.mocked(getFinalAudioSize).mockResolvedValue(1000);
    expect((await resolve(true, "streamable")).url).toContain("/stream/");
    expect(getFinalAudioSize).not.toHaveBeenCalled();
    expect(finalizeEpisodeAudio).not.toHaveBeenCalled();
  });

  it("hands out the signed Storage URL once the audio is complete and consolidated", async () => {
    vi.mocked(getFinalAudioSize).mockResolvedValue(1000);
    expect(await resolve(true)).toEqual(GCS);
    expect(finalizeEpisodeAudio).not.toHaveBeenCalled();
  });

  it("consolidates a complete episode that has no final.aac yet, then signs it", async () => {
    vi.mocked(getFinalAudioSize).mockResolvedValueOnce(null).mockResolvedValueOnce(1000);
    expect(await resolve(true)).toEqual(GCS);
    expect(finalizeEpisodeAudio).toHaveBeenCalledWith(POD, EP);
  });

  it("falls back to the /stream URL if consolidation fails", async () => {
    vi.mocked(getFinalAudioSize).mockResolvedValue(null);
    vi.mocked(finalizeEpisodeAudio).mockRejectedValue(new Error("compose failed"));
    expect((await resolve(true)).url).toContain("/stream/");
  });

  it("falls back to the /stream URL if final.aac is still missing after finalize", async () => {
    vi.mocked(getFinalAudioSize).mockResolvedValue(null);
    expect((await resolve(true)).url).toContain("/stream/");
    expect(getFinalAudioSignedUrl).not.toHaveBeenCalled();
  });

  it("falls back to the /stream URL if signing fails (e.g. missing signBlob permission)", async () => {
    vi.mocked(getFinalAudioSize).mockResolvedValue(1000);
    vi.mocked(getFinalAudioSignedUrl).mockRejectedValue(new Error("signBlob denied"));
    expect((await resolve(true)).url).toContain("/stream/");
  });
});
