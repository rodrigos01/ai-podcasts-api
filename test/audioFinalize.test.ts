import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/data/episode.repository", () => ({
  clearUnpinnedGuestVoices: vi.fn(),
  getEpisode: vi.fn(),
  getAudioEpoch: vi.fn(),
}));
vi.mock("../src/storage/audioCache.repository", () => ({
  composeFinalAudio: vi.fn(),
  deleteFinalAudio: vi.fn(),
  getFinalAudioSize: vi.fn(),
}));
vi.mock("../src/services/episodeGeneration/voiceResolution.service", () => ({
  cleanupGuestVoice: vi.fn(),
}));

import { clearUnpinnedGuestVoices, getAudioEpoch, getEpisode } from "../src/data/episode.repository";
import { finalizeEpisodeAudio } from "../src/services/episodeGeneration/audioFinalize.service";
import { cleanupGuestVoice } from "../src/services/episodeGeneration/voiceResolution.service";
import { composeFinalAudio, deleteFinalAudio, getFinalAudioSize } from "../src/storage/audioCache.repository";

// Two turns, small enough for a single chunk when chunked on the fly.
const TRANSCRIPT = "Maya: Hello there.\n\nJordan: Hi, Maya.";

const complete = (extra: Record<string, unknown> = {}) => ({
  id: "ep",
  audioComplete: true,
  transcript: TRANSCRIPT,
  ttsChunks: [{}, {}, {}],
  ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(clearUnpinnedGuestVoices).mockResolvedValue([]);
  vi.mocked(getFinalAudioSize).mockResolvedValue(null);
  vi.mocked(getAudioEpoch).mockResolvedValue(0);
});

describe("finalizeEpisodeAudio: consolidation", () => {
  it("composes the chunks into final.aac once the audio is complete", async () => {
    vi.mocked(getEpisode).mockResolvedValue(complete() as never);
    await finalizeEpisodeAudio("pod", "ep");
    expect(composeFinalAudio).toHaveBeenCalledWith("pod", "ep", 3);
    expect(deleteFinalAudio).not.toHaveBeenCalled();
  });

  it("does nothing before the audio is complete", async () => {
    vi.mocked(getEpisode).mockResolvedValue(complete({ audioComplete: false }) as never);
    await finalizeEpisodeAudio("pod", "ep");
    expect(composeFinalAudio).not.toHaveBeenCalled();
  });

  it("is idempotent: leaves an existing final.aac alone", async () => {
    vi.mocked(getEpisode).mockResolvedValue(complete() as never);
    vi.mocked(getFinalAudioSize).mockResolvedValue(1234);
    await finalizeEpisodeAudio("pod", "ep");
    expect(composeFinalAudio).not.toHaveBeenCalled();
  });

  it("counts the chunks from the transcript for an episode stored without ttsChunks", async () => {
    vi.mocked(getEpisode).mockResolvedValue(complete({ ttsChunks: null }) as never);
    await finalizeEpisodeAudio("pod", "ep");
    expect(composeFinalAudio).toHaveBeenCalledWith("pod", "ep", 1);
  });

  it("deletes the consolidated file again if the audio was cleared while it was being written", async () => {
    vi.mocked(getEpisode).mockResolvedValue(complete() as never);
    vi.mocked(getAudioEpoch).mockResolvedValueOnce(4).mockResolvedValueOnce(5);
    await finalizeEpisodeAudio("pod", "ep");
    expect(deleteFinalAudio).toHaveBeenCalledWith("pod", "ep");
  });

  it("shares one consolidation between concurrent callers", async () => {
    vi.mocked(getEpisode).mockResolvedValue(complete() as never);
    await Promise.all([finalizeEpisodeAudio("pod", "ep"), finalizeEpisodeAudio("pod", "ep")]);
    expect(composeFinalAudio).toHaveBeenCalledTimes(1);
  });

  it("still cleans up the guest voice, and surfaces a consolidation failure afterwards", async () => {
    const guest = { id: "g" };
    vi.mocked(clearUnpinnedGuestVoices).mockResolvedValue([guest] as never);
    vi.mocked(getEpisode).mockResolvedValue(complete() as never);
    vi.mocked(composeFinalAudio).mockRejectedValue(new Error("compose failed"));
    await expect(finalizeEpisodeAudio("pod", "ep")).rejects.toThrow("compose failed");
    expect(cleanupGuestVoice).toHaveBeenCalledWith(guest);
  });
});
