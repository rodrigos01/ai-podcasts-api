import { describe, expect, it } from "vitest";
import { episodeCreateRequestSchema, episodeCreateSchema } from "../src/schemas/episode.schema";

const base = {
  title: "Ep 1",
  topics: "Vintage filters",
  length: "short" as const,
  sourceIds: [],
  productionNotes: "Keep it punchy",
};

const guest = { name: "Guest", voice: "Puck" as const, persona: "A visiting expert" };

describe("episodeCreateSchema two-voice cast constraint", () => {
  it("accepts 2 hosts, 0 guests", () => {
    const result = episodeCreateSchema.safeParse({
      ...base,
      participantHostIds: ["h1", "h2"],
      guests: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts 1 host, 1 guest", () => {
    const result = episodeCreateSchema.safeParse({
      ...base,
      participantHostIds: ["h1"],
      guests: [guest],
    });
    expect(result.success).toBe(true);
  });

  it("rejects 1 host, 0 guests (solo host)", () => {
    const result = episodeCreateSchema.safeParse({
      ...base,
      participantHostIds: ["h1"],
      guests: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects 0 hosts, 0 guests", () => {
    const result = episodeCreateSchema.safeParse({
      ...base,
      participantHostIds: [],
      guests: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects 3 hosts", () => {
    const result = episodeCreateSchema.safeParse({
      ...base,
      participantHostIds: ["h1", "h2", "h3"],
      guests: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects 2 hosts + 1 guest (3 voices)", () => {
    const result = episodeCreateSchema.safeParse({
      ...base,
      participantHostIds: ["h1", "h2"],
      guests: [guest],
    });
    expect(result.success).toBe(false);
  });

  it("rejects 2 guests", () => {
    const result = episodeCreateSchema.safeParse({
      ...base,
      participantHostIds: [],
      guests: [guest, guest],
    });
    expect(result.success).toBe(false);
  });
});

const validEpisode = { ...base, participantHostIds: ["h1", "h2"], guests: [] };

describe("episodeCreateRequestSchema", () => {
  it("accepts a single confirmed episode", () => {
    const result = episodeCreateRequestSchema.safeParse({ episodes: [validEpisode] });
    expect(result.success).toBe(true);
  });

  it("accepts a confirmed 2-episode split, in order", () => {
    const result = episodeCreateRequestSchema.safeParse({
      episodes: [validEpisode, { ...validEpisode, title: "Ep 2" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty episodes array", () => {
    const result = episodeCreateRequestSchema.safeParse({ episodes: [] });
    expect(result.success).toBe(false);
  });

  it("rejects more than 2 episodes", () => {
    const result = episodeCreateRequestSchema.safeParse({
      episodes: [validEpisode, validEpisode, validEpisode],
    });
    expect(result.success).toBe(false);
  });
});
