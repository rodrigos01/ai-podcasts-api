import { describe, expect, it } from "vitest";
import { buildEpisodeRedraftPrompt, episodeRedraftSystemInstruction } from "../src/llm/prompts/episodeWizard.prompts";
import type { Episode } from "../src/schemas/episode.schema";
import type { Podcast } from "../src/schemas/podcast.schema";

const podcast: Podcast = {
  id: "p", title: "Show", description: "d", structure: "s", hosts: [], ownerId: "o", createdAt: 1, updatedAt: 1,
};
const episode = (overrides: Partial<Episode> = {}): Episode =>
  ({
    id: "e2", title: "Part 2", topics: "t", length: "medium", sourceIds: [], participantHostIds: [], guests: [],
    status: "ready", progress: null, transcript: null, ttsChunks: null, generatedAudioSeconds: 0, error: null,
    createdAt: 2, updatedAt: 2, ...overrides,
  }) as Episode;
const prior = [{ number: 1, episode: episode({ id: "e1", title: "Old", transcript: "Penny: OLD-TRANSCRIPT" }) }];

describe("episode redraft prompts", () => {
  it("pastes the transcripts when the call is not chained, like the wizard", () => {
    const text = episodeRedraftSystemInstruction(podcast, episode(), prior);
    expect(text).toContain("OLD-TRANSCRIPT");
    expect(text).not.toContain("already in this conversation");
  });

  it("points at the conversation when chained, with no transcripts", () => {
    const text = episodeRedraftSystemInstruction(podcast, episode(), [], true);
    expect(text).toContain("already in this conversation");
    expect(text).not.toContain("OLD-TRANSCRIPT");
  });

  it("fixes the cast size: no guest, or exactly one", () => {
    expect(episodeRedraftSystemInstruction(podcast, episode(), [])).toContain("Do not add a guest");
    const withGuest = episode({ guests: [{ id: "g", name: "Gus", persona: "p", voice: "v" } as Episode["guests"][number]] });
    expect(episodeRedraftSystemInstruction(podcast, withGuest, [])).toContain("exactly one guest");
  });

  it("shows the current draft", () => {
    expect(buildEpisodeRedraftPrompt(episode({ title: "Part 2: Stone" }), [])).toContain("Title: Part 2: Stone");
  });
});
