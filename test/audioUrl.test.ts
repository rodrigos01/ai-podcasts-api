import { describe, expect, it } from "vitest";
import { episodeAudioUrl } from "../src/utils/audioUrl";

describe("episodeAudioUrl", () => {
  it("builds the stable public URL from the request origin", () => {
    expect(episodeAudioUrl("https://api.example.com", "pod1", "ep1")).toBe(
      "https://api.example.com/podcasts/pod1/episodes/ep1/audio",
    );
  });
});
