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

  // The schema itself no longer enforces which entry has which episode
  // count, or their order — that cross-entry convention can't be expressed
  // in Gemini's structured-output schema, so a schema-valid-but-misordered
  // response (e.g. a 2-episode suggestion first, or two 1-episode
  // suggestions) is accepted here and repaired afterward instead — see
  // episodeWizard.service.test.ts's normalizeSuggestions tests.
  it("accepts a 2-episode suggestion first (order not schema-enforced)", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [draft, draft] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts two 1-episode suggestions (uniqueness not schema-enforced)", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [draft] }, { episodes: [draft] }],
    });
    expect(result.success).toBe(true);
  });
});
