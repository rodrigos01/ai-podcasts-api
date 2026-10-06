import { describe, expect, it } from "vitest";
import { personInputSchema, personSaveSchema, personSchema } from "../src/schemas/person.schema";

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

describe("personInputSchema English fields", () => {
  const base = { name: "Maya Cruz", voice: "warm voice", persona: "Uma anfitriã curiosa." };

  it("no longer carries English persona/accent fields: they're stripped, not stored", () => {
    const parsed = personInputSchema.parse({ ...base, personaEn: "A curious host.", accentEn: "Rio accent" });
    expect(parsed).not.toHaveProperty("personaEn");
    expect(parsed).not.toHaveProperty("accentEn");
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

describe("personSaveSchema resolvedVoiceId", () => {
  it("is an optional input, so a client can echo a GET back or omit it", () => {
    const base = { name: "A", voice: "v", persona: "p" };
    expect(personSaveSchema.safeParse(base).success).toBe(true);
    expect(personSaveSchema.parse({ ...base, resolvedVoiceId: "voice_x" }).resolvedVoiceId).toBe("voice_x");
    // The other server-managed fields are never accepted.
    expect(personSaveSchema.parse({ ...base, resolvedVoiceHash: "x", resolvedVoicePinned: true })).not.toHaveProperty(
      "resolvedVoicePinned",
    );
  });
});
