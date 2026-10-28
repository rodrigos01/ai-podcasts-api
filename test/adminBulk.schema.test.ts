import { describe, expect, it } from "vitest";
import { changeOwnerRequestSchema, regenerateEpisodesRequestSchema } from "../src/schemas/adminBulk.schema";

describe("admin bulk request schemas", () => {
  it("de-duplicates ids and defaults redraft to false", () => {
    const parsed = regenerateEpisodesRequestSchema.parse({ podcastId: "p", episodeIds: ["a", "a", "b"] });
    expect(parsed).toEqual({ podcastId: "p", episodeIds: ["a", "b"], redraft: false });
  });

  it("rejects empty and oversized selections", () => {
    expect(changeOwnerRequestSchema.safeParse({ podcastIds: [], ownerId: "u" }).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => `p${i}`);
    expect(changeOwnerRequestSchema.safeParse({ podcastIds: many, ownerId: "u" }).success).toBe(false);
  });

  it("requires an owner", () => {
    expect(changeOwnerRequestSchema.safeParse({ podcastIds: ["p"] }).success).toBe(false);
    expect(changeOwnerRequestSchema.safeParse({ podcastIds: ["p"], ownerId: "" }).success).toBe(false);
  });
});
