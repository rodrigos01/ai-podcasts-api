import { describe, expect, it } from "vitest";
import { episodeWizardSystemInstruction } from "../src/llm/prompts/episodeWizard.prompts";
import type { Episode } from "../src/schemas/episode.schema";
import type { Podcast } from "../src/schemas/podcast.schema";

const podcast: Podcast = {
  id: "p", title: "Show", description: "d", structure: "s", hosts: [], ownerId: "o", createdAt: 1, updatedAt: 1,
};
const prior = [
  {
    number: 1,
    episode: {
      id: "e1", title: "Old", topics: "t", length: "medium", sourceIds: [], participantHostIds: [], guests: [],
      status: "ready", progress: null, transcript: "Penny: OLD-TRANSCRIPT", ttsChunks: null, generatedAudioSeconds: 0,
      error: null, createdAt: 1, updatedAt: 1,
    } as Episode,
  },
];

describe("episode wizard system instruction", () => {
  it("pastes the transcripts when the call is not chained", () => {
    const text = episodeWizardSystemInstruction(podcast, "medium", prior);
    expect(text).toContain("OLD-TRANSCRIPT");
    expect(text).toContain("keep this history in mind");
    expect(text).not.toContain("already in this conversation");
  });

  it("points at the conversation when chained, and keeps the drafting guidance", () => {
    const text = episodeWizardSystemInstruction(podcast, "medium", [], true);
    expect(text).toContain("already in this conversation");
    expect(text).toContain("Use them for continuity");
    expect(text).toContain("keep this history in mind");
    expect(text).not.toContain("Previous episodes of this podcast");
  });

  it("has no history section for a first episode", () => {
    expect(episodeWizardSystemInstruction(podcast, "medium", [])).not.toContain("history");
  });
});
