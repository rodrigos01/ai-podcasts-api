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

  it("asks for continuity notes only from a podcast that opted out of interaction context, and not for a first episode", () => {
    const optedOut = { ...podcast, useInteractionContext: false } as Podcast;
    expect(episodeWizardSystemInstruction(optedOut, "medium", prior)).toContain('"continuityNotes"');
    expect(episodeWizardSystemInstruction(optedOut, "medium", [])).not.toContain('"continuityNotes"');
    expect(episodeWizardSystemInstruction(podcast, "medium", prior)).not.toContain('"continuityNotes"');
  });

  it("asks for context as well as continuation points in the notes", () => {
    const system = episodeWizardSystemInstruction({ ...podcast, useInteractionContext: false } as Podcast, "medium", prior);
    expect(system).toContain("Context and continuity notes");
    expect(system).toContain("- Context:");
    expect(system).toContain("- Continuation:");
  });

  it("has no history section for a first episode", () => {
    expect(episodeWizardSystemInstruction(podcast, "medium", [])).not.toContain("history");
  });
});
