import { describe, expect, it } from "vitest";
import {
  episodeWizardOptionsResponseSchema,
  episodeWizardReviseRequestSchema,
  podcastWizardReviseRequestSchema,
} from "../src/schemas/wizard.schema";

const draft = {
  title: "Ep 1",
  topics: "Vintage filters",
  productionNotes: "Keep it punchy",
  guests: [],
  predictedChanges: ["a", "b", "c"],
};

describe("episodeWizardOptionsResponseSchema suggestions shape", () => {
  it("accepts a draft without production notes", () => {
    const { productionNotes: _omitted, ...withoutNotes } = draft;
    const result = episodeWizardOptionsResponseSchema.safeParse({
      suggestions: [{ episodes: [withoutNotes] }],
    });
    expect(result.success).toBe(true);
  });

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

describe("wizard revise requests", () => {
  it("accept an optional voice-design sessionId", () => {
    const option = {
      title: "t",
      description: "d",
      structure: "s",
      hosts: [{ name: "A", voice: "warm", persona: "p" }],
      predictedChanges: ["a", "b", "c"],
    };
    const base = { options: [option, option, option], instruction: "x" };
    expect(podcastWizardReviseRequestSchema.safeParse(base).success).toBe(true);
    expect(podcastWizardReviseRequestSchema.safeParse({ ...base, sessionId: "abc" }).success).toBe(true);
    expect(podcastWizardReviseRequestSchema.safeParse({ ...base, sessionId: "" }).success).toBe(false);
  });

  it("tolerate clients echoing a wizard-added voicePrompt back, or not sending one", () => {
    const person = { name: "A", voice: "warm", persona: "p" };
    const option = {
      title: "t",
      description: "d",
      structure: "s",
      predictedChanges: ["a", "b", "c"],
    };
    const withPrompt = { ...option, hosts: [{ ...person, voicePrompt: "Name: A\n\np" }] };
    const parsed = podcastWizardReviseRequestSchema.parse({
      options: [withPrompt, withPrompt, withPrompt],
      instruction: "x",
    });
    // Not part of the wizard (LLM-facing) shape: dropped, never fed to the model.
    expect(parsed.options[0]?.hosts[0]).not.toHaveProperty("voicePrompt");

    const draft = { title: "t", topics: "t", predictedChanges: ["a", "b", "c"], guests: [{ ...person, voicePrompt: "x" }] };
    expect(
      episodeWizardReviseRequestSchema.safeParse({
        suggestions: [{ episodes: [draft] }],
        length: "short",
        targetSuggestionIndex: 0,
        instruction: "x",
      }).success,
    ).toBe(true);
  });
});
