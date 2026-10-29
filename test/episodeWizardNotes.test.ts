import { describe, expect, it } from "vitest";
import { episodeWizardSystemInstruction } from "../src/llm/prompts/episodeWizard.prompts";
import { episodeDraftSchema } from "../src/schemas/wizard.schema";
import { usesInteractionContext } from "../src/services/episodeGeneration/continuity";
import type { Podcast } from "../src/schemas/podcast.schema";

const podcast = { id: "p", title: "Show", description: "d", structure: "s", hosts: [] } as unknown as Podcast;
const prior = [{ number: 1, episode: { id: "e", title: "One", transcript: "Penny: hi", participantHostIds: [], guests: [] } }] as never;

describe("episode wizard continuity notes", () => {
  it("asks for notes only for a podcast on continuity notes that has earlier episodes", () => {
    const off = episodeWizardSystemInstruction(podcast, "short", prior);
    const on = episodeWizardSystemInstruction({ ...podcast, continuityNotes: true }, "short", prior);
    const noHistory = episodeWizardSystemInstruction({ ...podcast, continuityNotes: true }, "short", []);
    expect(off).not.toContain("continuityNotes");
    expect(on).toContain('"continuityNotes"');
    expect(noHistory).not.toContain('"continuityNotes"');
    expect(on).toContain("The show's formula");
    expect(on).toContain("verbatim");
    expect(on).toContain("Be specific");
  });

  it("accepts a draft with or without notes", () => {
    const draft = { title: "t", topics: "x", guests: [], predictedChanges: ["a", "b", "c"] };
    expect(episodeDraftSchema.parse(draft).continuityNotes).toBeUndefined();
    expect(episodeDraftSchema.parse({ ...draft, continuityNotes: "Episode 1: a callback" }).continuityNotes).toBe("Episode 1: a callback");
  });

  it("never chains a podcast on continuity notes", () => {
    expect(usesInteractionContext({ continuityNotes: true })).toBe(false);
    expect(usesInteractionContext({})).toBe(true);
  });
});
