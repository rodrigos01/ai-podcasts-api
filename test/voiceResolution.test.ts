import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Person } from "../src/schemas/person.schema";

vi.mock("../src/llm/geminiClient", () => ({
  generateText: vi.fn(),
}));

vi.mock("../src/llm/ttsClient", () => ({
  designVoice: vi.fn(),
  deleteVoice: vi.fn(),
}));

vi.mock("../src/data/episode.repository", () => ({
  setGuestResolvedVoice: vi.fn(),
}));

vi.mock("../src/data/podcast.repository", () => ({
  setHostResolvedVoice: vi.fn(),
}));

import { generateText } from "../src/llm/geminiClient";
import { deleteVoice, designVoice } from "../src/llm/ttsClient";
import { setGuestResolvedVoice } from "../src/data/episode.repository";
import { setHostResolvedVoice } from "../src/data/podcast.repository";
import { cleanupGuestVoice, hasCurrentVoice, resolveGuestVoice, resolveHostVoice } from "../src/services/episodeGeneration/voiceResolution.service";

describe("voiceResolution.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveGuestVoice", () => {
    it("always designs a voice for guests using name, persona, voice hint, and accent data", async () => {
      const guestWithoutAccent: Person = {
        id: "guest-1",
        name: "Dr. Evelyn Reed",
        persona: "A marine biologist passionate about deep-sea exploration.",
        voice: "authoritative yet enthusiastic",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      };

      vi.mocked(generateText).mockResolvedValueOnce({
        languageCode: "en-US",
        languageName: "English",
        gender: "female",
        voiceDescription: "A clear, articulate female voice with enthusiastic pacing and warm resonance.",
        displayName: "Evelyn Reed Voice",
      });
      vi.mocked(designVoice).mockResolvedValueOnce("custom-voice-123");

      const result = await resolveGuestVoice("pod-1", "ep-1", guestWithoutAccent);

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Dr. Evelyn Reed"),
        }),
      );
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("marine biologist"),
        }),
      );
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("authoritative yet enthusiastic"),
        }),
      );

      expect(designVoice).toHaveBeenCalledWith({
        displayName: "Evelyn Reed Voice",
        languageCode: "en-US",
        gender: "female",
        voiceDescription: "A clear, articulate female voice with enthusiastic pacing and warm resonance.",
      });

      expect(setGuestResolvedVoice).toHaveBeenCalledWith("pod-1", "ep-1", "guest-1", {
        resolvedVoiceId: "custom-voice-123",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      expect(result).toEqual({
        voiceId: "custom-voice-123",
        origin: "design",
      });
    });

    it("includes stated accent when designing guest voice", async () => {
      const guestWithAccent: Person = {
        id: "guest-2",
        name: "Mateo Silva",
        persona: "An astrophysicist from Buenos Aires discussing radio astronomy.",
        voice: "thoughtful, melodic",
        accent: "Argentine Spanish accent",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      };

      vi.mocked(generateText).mockResolvedValueOnce({
        languageCode: "es-AR",
        languageName: "Spanish",
        gender: "male",
        voiceDescription: "A thoughtful male voice speaking with a distinct Argentine cadence and melodic intonation.",
        displayName: "Mateo Silva Voice",
      });
      vi.mocked(designVoice).mockResolvedValueOnce("custom-voice-456");

      const result = await resolveGuestVoice("pod-1", "ep-1", guestWithAccent);

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Stated accent: Argentine Spanish accent"),
        }),
      );

      expect(result).toEqual({
        voiceId: "custom-voice-456",
        origin: "design",
      });
    });

    it("cleans up stale voice if guest already had a designed voice on regeneration", async () => {
      const guestWithStaleVoice: Person = {
        id: "guest-3",
        name: "Sarah Chen",
        persona: "AI researcher.",
        voice: "calm, analytical",
        resolvedVoiceId: "old-voice-789",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: "hash-recorded-on-this-platform",
      };

      vi.mocked(generateText).mockResolvedValueOnce({
        languageCode: "en-US",
        languageName: "English",
        gender: "female",
        voiceDescription: "A calm, analytical female voice with measured articulation.",
        displayName: "Sarah Chen Voice",
      });
      vi.mocked(designVoice).mockResolvedValueOnce("new-voice-999");

      await resolveGuestVoice("pod-1", "ep-1", guestWithStaleVoice);

      expect(deleteVoice).toHaveBeenCalledWith("old-voice-789");
    });

    it("does not try to delete a stored guest voice with no recorded hash (designed on the previous platform)", async () => {
      const guestWithForeignVoice: Person = {
        id: "guest-4",
        name: "Omar Haddad",
        persona: "A historian.",
        voice: "measured",
        resolvedVoiceId: "voice_designed_on_ai_studio",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: null,
      };

      vi.mocked(generateText).mockResolvedValueOnce({
        languageCode: "en-US",
        languageName: "English",
        gender: "male",
        voiceDescription: "A measured male voice.",
        displayName: "Omar Haddad Voice",
      });
      vi.mocked(designVoice).mockResolvedValueOnce("voice_designed_on_enterprise");

      await resolveGuestVoice("pod-1", "ep-1", guestWithForeignVoice);

      expect(designVoice).toHaveBeenCalledTimes(1);
      expect(deleteVoice).not.toHaveBeenCalled();
    });
  });

  describe("hasCurrentVoice", () => {
    const person: Person = {
      id: "p-1",
      name: "Omar Haddad",
      persona: "A historian.",
      voice: "measured",
      resolvedVoiceId: null,
      resolvedVoiceOrigin: null,
      resolvedVoiceHash: null,
    };

    it("is false with no stored voice, and false for a stored id with no recorded hash", () => {
      expect(hasCurrentVoice(person)).toBe(false);
      expect(hasCurrentVoice({ ...person, resolvedVoiceId: "voice_x", resolvedVoiceHash: null })).toBe(false);
    });

    it("is false when the recorded hash doesn't match the current one", () => {
      expect(hasCurrentVoice({ ...person, resolvedVoiceId: "voice_x", resolvedVoiceHash: "stale" })).toBe(false);
    });

    it("is true for a voice recorded by this service, and false once the persona changes", async () => {
      vi.mocked(generateText).mockResolvedValueOnce({
        languageCode: "en-US",
        languageName: "English",
        gender: "male",
        voiceDescription: "A measured male voice.",
        displayName: "Omar Haddad Voice",
      });
      vi.mocked(designVoice).mockResolvedValueOnce("voice_new");
      await resolveGuestVoice("pod-1", "ep-1", person);

      const recorded = vi.mocked(setGuestResolvedVoice).mock.calls[0]![3];
      const withVoice: Person = {
        ...person,
        resolvedVoiceId: recorded.resolvedVoiceId,
        resolvedVoiceOrigin: recorded.resolvedVoiceOrigin,
        resolvedVoiceHash: recorded.resolvedVoiceHash,
      };

      expect(hasCurrentVoice(withVoice)).toBe(true);
      expect(hasCurrentVoice({ ...withVoice, persona: "A different persona." })).toBe(false);
    });
  });

  describe("resolveHostVoice", () => {
    it("re-designs a host whose cached voice was stored before the move to the Enterprise Voices API", async () => {
      // The hash a host's voice was cached under before VOICE_BACKEND_VERSION
      // existed — a `voice_...` id designed on AI Studio, which the
      // Enterprise Voices API has never heard of. It must NOT be reused.
      const legacyHash = createHash("sha256")
        .update("Maya Cruz\u0000A curious host.\u0000\u0000warm and quick")
        .digest("hex");
      const host: Person = {
        id: "host-1",
        name: "Maya Cruz",
        persona: "A curious host.",
        voice: "warm and quick",
        resolvedVoiceId: "voice_designed_on_ai_studio",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: legacyHash,
      };

      vi.mocked(generateText).mockResolvedValueOnce({
        languageCode: "en-US",
        languageName: "English",
        gender: "female",
        voiceDescription: "A warm, quick female voice.",
        displayName: "Maya Cruz Voice",
      });
      vi.mocked(designVoice).mockResolvedValueOnce("voice_designed_on_enterprise");

      const result = await resolveHostVoice("pod-1", host);

      expect(result).toEqual({ voiceId: "voice_designed_on_enterprise" });
      expect(designVoice).toHaveBeenCalledTimes(1);
      expect(setHostResolvedVoice).toHaveBeenCalledWith(
        "pod-1",
        "host-1",
        expect.objectContaining({ resolvedVoiceId: "voice_designed_on_enterprise" }),
      );
    });
  });

  describe("cleanupGuestVoice", () => {
    it("deletes guest voice when origin is design", async () => {
      const guest: Person = {
        id: "guest-1",
        name: "Guest",
        persona: "Persona",
        voice: "Voice",
        resolvedVoiceId: "voice-to-delete",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: null,
      };

      await cleanupGuestVoice(guest);

      expect(deleteVoice).toHaveBeenCalledWith("voice-to-delete");
    });
  });
});
