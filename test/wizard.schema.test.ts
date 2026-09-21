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

  // There is no positional convention — a lone suggestion can itself be a
  // split (e.g. the user's own prompt asked for the material to be split
  // into multiple episodes, so there's no separate single-episode option to
  // offer at all), and a second suggestion, when present, doesn't have to
  // differ in episode count from the first. Each entry's shape is fully
  // described by its own `episodes.length` — no client should key off
  // array position instead.
  it("accepts a lone suggestion that is itself a 2-episode split", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [draft, draft] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts two single-episode suggestions as genuine alternatives", () => {
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [draft] }, { episodes: [draft] }],
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
});
