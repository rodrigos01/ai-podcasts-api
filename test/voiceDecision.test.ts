import { describe, expect, it } from "vitest";
import type { Person } from "../src/schemas/person.schema";
import { decideVoice, NO_VOICE } from "../src/utils/voiceDecision";
import { hasCurrentVoice, voiceHash } from "../src/utils/voiceHash";

const incoming = {
  name: "Maya Cruz",
  voice: "warm",
  persona: "A producer.",
  personaEn: "A producer.",
  voicePrompt: "Name: Maya Cruz\n\nA producer.",
};

function stored(overrides: Partial<Person> = {}): Person {
  return {
    ...incoming,
    id: "h1",
    resolvedVoiceId: "voice_old",
    resolvedVoiceOrigin: "design",
    resolvedVoiceHash: "somehash",
    ...overrides,
  };
}

describe("decideVoice", () => {
  const pick = { voiceId: "voice_new", prompt: "Name: Maya Cruz\n\nThe prompt the pick was designed from." };

  it("stores a pick pinned, with the prompt it was designed from, and replaces the old voice", () => {
    const hashed = { ...incoming, voicePrompt: pick.prompt };
    const decision = decideVoice(stored(), incoming, pick);
    expect(decision.fields).toEqual({
      resolvedVoiceId: "voice_new",
      resolvedVoiceOrigin: "design",
      resolvedVoiceHash: voiceHash(hashed),
      resolvedVoicePinned: true,
    });
    expect(decision.voicePrompt).toBe(pick.prompt);
    expect(decision.replacedVoiceId).toBe("voice_old");
  });

  it("does not delete a replaced voice from before the platform move (no hash)", () => {
    const decision = decideVoice(stored({ resolvedVoiceHash: null }), incoming, pick);
    expect(decision.replacedVoiceId).toBeUndefined();
  });

  it("applies a pick to a brand-new person with nothing to replace", () => {
    const decision = decideVoice(undefined, incoming, pick);
    expect(decision.fields?.resolvedVoiceId).toBe("voice_new");
    expect(decision.replacedVoiceId).toBeUndefined();
  });

  it("leaves the voice alone with no pick and an unchanged prompt", () => {
    expect(decideVoice(stored(), incoming, null)).toEqual({ fields: null });
  });

  it("drops the stored voice, to be designed from the new prompt, when the prompt changed and nothing was picked", () => {
    const decision = decideVoice(stored(), { ...incoming, voicePrompt: "Name: Maya Cruz\n\nA different bio." }, null);
    expect(decision.fields).toEqual({ ...NO_VOICE, resolvedVoicePinned: false });
    expect(decision.replacedVoiceId).toBe("voice_old");
  });

  it("never touches a person stored without a prompt (the hash covers them)", () => {
    const decision = decideVoice(stored({ voicePrompt: undefined }), incoming, null);
    expect(decision).toEqual({ fields: null });
  });

  it("has nothing to drop when the person had no voice yet", () => {
    const decision = decideVoice(
      stored({ resolvedVoiceId: null, resolvedVoiceHash: null }),
      { ...incoming, voicePrompt: "changed" },
      null,
    );
    expect(decision).toEqual({ fields: null });
  });
});

describe("hasCurrentVoice for a picked voice", () => {
  it("stays valid when the text it was hashed from has since changed", () => {
    const pinned = stored({ resolvedVoiceHash: "stale", resolvedVoicePinned: true });
    expect(hasCurrentVoice(pinned)).toBe(true);
    expect(hasCurrentVoice({ ...pinned, resolvedVoicePinned: false })).toBe(false);
  });
});
