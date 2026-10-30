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
  it("pastes the transcripts", () => {
    const text = episodeWizardSystemInstruction(podcast, "medium", prior);
    expect(text).toContain("OLD-TRANSCRIPT");
    expect(text).toContain("keep this history in mind");
  });

  it("asks for continuity notes when there is history, and not for a first episode", () => {
    const withHistory = episodeWizardSystemInstruction(podcast, "medium", prior);
    expect(withHistory).toContain('"continuityNotes"');
    expect(episodeWizardSystemInstruction(podcast, "medium", [])).not.toContain('"continuityNotes"');
  });

  it("has no history section for a first episode", () => {
    expect(episodeWizardSystemInstruction(podcast, "medium", [])).not.toContain("history");
  });
});
