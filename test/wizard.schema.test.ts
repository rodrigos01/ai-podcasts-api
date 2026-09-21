import { describe, expect, it } from "vitest";
import { episodeWizardOptionsResponseSchema } from "../src/schemas/wizard.schema";

const draft = {
  title: "Ep 1",
  topics: "Vintage filters",
  productionNotes: "Keep it punchy",
  guests: [],
  predictedChanges: ["a", "b", "c"],
};

describe("episodeWizardOptionsResponseSchema suggestions shape", () => {
  it("accepts a single suggestion with one episode (no split needed)", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [draft] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single-episode suggestion followed by a 2-episode split suggestion", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [draft] }, { episodes: [draft, draft] }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty suggestions array", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({ suggestions: [] });
    expect(result.success).toBe(false);
  });

  it("rejects more than 2 suggestions", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [draft] }, { episodes: [draft, draft] }, { episodes: [draft] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a first suggestion with 2 episodes (must be the single-episode option)", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [draft, draft] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a second suggestion that isn't a 2-episode split", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [draft] }, { episodes: [draft] }],
    });
    expect(result.success).toBe(false);
  });
});
