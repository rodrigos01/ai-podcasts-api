import { describe, expect, it } from "vitest";
import { episodeWizardSystemInstruction } from "../src/llm/prompts/episodeWizard.prompts";
import { episodeDraftSchema } from "../src/schemas/wizard.schema";
import type { Podcast } from "../src/schemas/podcast.schema";

const podcast = { id: "p", title: "Show", description: "d", structure: "s", hosts: [] } as unknown as Podcast;
const prior = [{ number: 1, episode: { id: "e", title: "One", transcript: "Penny: hi", participantHostIds: [], guests: [] } }] as never;

describe("episode wizard continuity notes", () => {
  it("asks for tailored, specific notes with the show's formula, only when there are earlier episodes", () => {
    const on = episodeWizardSystemInstruction(podcast, "short", prior);
    expect(on).toContain('"continuityNotes"');
    expect(on).toContain("The show's formula");
    expect(on).toContain("verbatim");
    expect(on).toContain("Be specific");
    expect(on).toContain("never tell the hosts or the guest what to do with it");
    expect(episodeWizardSystemInstruction(podcast, "short", [])).not.toContain('"continuityNotes"');
  });

  it("accepts a draft with or without notes", () => {
    const draft = { title: "t", topics: "x", guests: [], predictedChanges: ["a", "b", "c"] };
    expect(episodeDraftSchema.parse(draft).continuityNotes).toBeUndefined();
    expect(episodeDraftSchema.parse({ ...draft, continuityNotes: "Episode 1: a callback" }).continuityNotes).toBe("Episode 1: a callback");
  });
});
