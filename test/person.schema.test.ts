import { describe, expect, it } from "vitest";
import { personInputSchema, personSchema } from "../src/schemas/person.schema";

describe("personInputSchema voice field", () => {
  it("accepts a free-text voice description, not just a fixed catalog ID", () => {
    const result = personInputSchema.safeParse({
      name: "Maya Cruz",
      voice: "warm, gravelly older British male with a dry sense of humor",
      persona: "A veteran audio engineer with strong opinions about tape hiss.",
    });
    expect(result.success).toBe(true);
  });

  it("still rejects an empty voice string", () => {
    const result = personInputSchema.safeParse({
      name: "Maya Cruz",
      voice: "",
      persona: "test persona",
    });
    expect(result.success).toBe(false);
  });

  it("does not accept client-supplied resolved-voice fields", () => {
    // personInputSchema (the client-writable shape) has no
    // resolvedVoiceId/Origin/Hash fields at all — those are server-managed,
    // only added by personSchema (the persisted/read shape). Passing them
    // in an input payload should not make them "stick" (zod strips unknown
    // keys by default), and personInputSchema.parse should still succeed.
    const result = personInputSchema.parse({
      name: "Maya Cruz",
      voice: "warm voice",
      persona: "test persona",
      resolvedVoiceId: "voice_smuggled",
    });
    expect(result).not.toHaveProperty("resolvedVoiceId");
  });
});

describe("personSchema (persisted shape)", () => {
  it("requires the server-managed resolved-voice fields, nullable", () => {
    const result = personSchema.safeParse({
      id: "p1",
      name: "Maya Cruz",
      voice: "warm voice",
      persona: "test persona",
      resolvedVoiceId: null,
      resolvedVoiceOrigin: null,
      resolvedVoiceHash: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a resolved design-origin voice", () => {
    const result = personSchema.safeParse({
      id: "p1",
      name: "Maya Cruz",
      voice: "warm voice",
      persona: "test persona",
      resolvedVoiceId: "voice_abc123",
      resolvedVoiceOrigin: "design",
      resolvedVoiceHash: "somehash",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid resolvedVoiceOrigin value", () => {
    const result = personSchema.safeParse({
      id: "p1",
      name: "Maya Cruz",
      voice: "warm voice",
      persona: "test persona",
      resolvedVoiceId: "voice_abc123",
      resolvedVoiceOrigin: "prebuilt",
      resolvedVoiceHash: "somehash",
    });
    expect(result.success).toBe(false);
  });
});
