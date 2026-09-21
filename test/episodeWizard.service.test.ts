import { describe, expect, it } from "vitest";
import { normalizeSuggestions } from "../src/services/episodeWizard.service";
import type { EpisodeSuggestion } from "../src/schemas/wizard.schema";

function draft(title: string) {
  return {
    title,
    topics: "Vintage filters",
    productionNotes: "Keep it punchy",
    guests: [],
    predictedChanges: ["a", "b", "c"],
  };
}

const single: EpisodeSuggestion = { episodes: [draft("Solo")] };
const split: EpisodeSuggestion = { episodes: [draft("Part 1"), draft("Part 2")] };

describe("normalizeSuggestions", () => {
  it("leaves an already-correct [single] shape unchanged", () => {
    expect(normalizeSuggestions([single])).toEqual([single]);
  });

  it("leaves an already-correct [single, split] shape unchanged", () => {
    expect(normalizeSuggestions([single, split])).toEqual([single, split]);
  });

  it("reorders a [split, single] response into [single, split]", () => {
    expect(normalizeSuggestions([split, single])).toEqual([single, split]);
  });

  it("drops a duplicate single, keeping [single, split]", () => {
    const duplicateSingle: EpisodeSuggestion = { episodes: [draft("Also solo")] };
    expect(normalizeSuggestions([single, duplicateSingle, split])).toEqual([single, split]);
  });

  it("keeps just the first single when there's no split at all", () => {
    const duplicateSingle: EpisodeSuggestion = { episodes: [draft("Also solo")] };
    expect(normalizeSuggestions([single, duplicateSingle])).toEqual([single]);
  });

  it("synthesizes a single-episode suggestion from the split when no single was returned", () => {
    const result = normalizeSuggestions([split]);
    expect(result).toEqual([{ episodes: [split.episodes[0]] }, split]);
  });
});
