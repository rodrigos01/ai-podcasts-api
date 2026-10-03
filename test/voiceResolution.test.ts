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
    it("designs from the stored English persona alone, with no LLM call and no accent line", async () => {
      const guest: Person = {
        id: "guest-1",
        name: "Dr. Evelyn Reed",
        persona: "A marine biologist passionate about deep-sea exploration.",
        personaEn: "A marine biologist passionate about deep-sea exploration.",
        voice: "authoritative yet enthusiastic",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      };
      vi.mocked(designVoice).mockResolvedValueOnce("custom-voice-123");

      const result = await resolveGuestVoice("pod-1", "ep-1", guest);

      expect(generateText).not.toHaveBeenCalled();
      expect(designVoice).toHaveBeenCalledWith({
        voiceDescription: "Name: Dr. Evelyn Reed\n\nA marine biologist passionate about deep-sea exploration.",
      });
      expect(setGuestResolvedVoice).toHaveBeenCalledWith("pod-1", "ep-1", "guest-1", {
        resolvedVoiceId: "custom-voice-123",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(result).toEqual({ voiceId: "custom-voice-123", origin: "design" });
    });

    it("sends the English persona and English accent, not the originals, for a non-English guest", async () => {
      const guest: Person = {
        id: "guest-2",
        name: "Jessica Miller",
        persona: "Jessica Miller, 35, uma americana de Boston que mora no Brasil há cinco anos.",
        personaEn: "Jessica Miller, 35, an American from Boston who has lived in Brazil for five years.",
        voice: "simpática, pausada",
        accent: "sotaque americano marcado ao falar português",
        accentEn: "strong American accent when speaking Portuguese",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      };
      vi.mocked(designVoice).mockResolvedValueOnce("custom-voice-456");

      await resolveGuestVoice("pod-1", "ep-1", guest);

      expect(generateText).not.toHaveBeenCalled();
      expect(designVoice).toHaveBeenCalledWith({
        voiceDescription:
          "Name: Jessica Miller\n\nJessica Miller, 35, an American from Boston who has lived in Brazil for five years.\n\n" +
          "Accent: strong American accent when speaking Portuguese",
      });
    });

    it("translates on demand for a person with no English fields (created before they existed)", async () => {
      const guest: Person = {
        id: "guest-5",
        name: "Lúcia Barbosa",
        persona: "Lúcia, 56, cozinheira de Recife.",
        voice: "calorosa",
        accent: "sotaque nordestino",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      };
      vi.mocked(generateText).mockResolvedValueOnce({
        personaEn: "Lúcia, 56, a cook from Recife.",
        accentEn: "Northeastern Brazilian accent",
      });
      vi.mocked(designVoice).mockResolvedValueOnce("custom-voice-789");

      await resolveGuestVoice("pod-1", "ep-1", guest);

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Stated accent: sotaque nordestino"),
        }),
      );
      expect(designVoice).toHaveBeenCalledWith({
        voiceDescription: "Name: Lúcia Barbosa\n\nLúcia, 56, a cook from Recife.\n\nAccent: Northeastern Brazilian accent",
      });
    });

    it("translates when the accent has no English counterpart, and never invents an accent for an accent-less person", async () => {
      vi.mocked(generateText).mockResolvedValueOnce({ personaEn: "A host.", accentEn: "made-up accent" });
      vi.mocked(designVoice).mockResolvedValueOnce("v1");
      await resolveGuestVoice("pod-1", "ep-1", {
        id: "g",
        name: "G",
        persona: "Uma anfitriã.",
        personaEn: "A host.",
        voice: "v",
        accent: "carioca",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      });
      expect(generateText).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();
      vi.mocked(generateText).mockResolvedValueOnce({ personaEn: "A host.", accentEn: "made-up accent" });
      vi.mocked(designVoice).mockResolvedValueOnce("v2");
      await resolveGuestVoice("pod-1", "ep-1", {
        id: "g",
        name: "G",
        persona: "Uma anfitriã.",
        voice: "v",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      });
      expect(designVoice).toHaveBeenCalledWith({ voiceDescription: "Name: G\n\nA host." });
    });

    it("cleans up stale voice if guest already had a designed voice on regeneration", async () => {
      const guestWithStaleVoice: Person = {
        id: "guest-3",
        name: "Sarah Chen",
        persona: "AI researcher.",
        personaEn: "AI researcher.",
        voice: "calm, analytical",
        resolvedVoiceId: "old-voice-789",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: "hash-recorded-on-this-platform",
      };
      vi.mocked(designVoice).mockResolvedValueOnce("new-voice-999");

      await resolveGuestVoice("pod-1", "ep-1", guestWithStaleVoice);

      expect(deleteVoice).toHaveBeenCalledWith("old-voice-789");
    });

    it("does not try to delete a stored guest voice with no recorded hash (designed on the previous platform)", async () => {
      const guestWithForeignVoice: Person = {
        id: "guest-4",
        name: "Omar Haddad",
        persona: "A historian.",
        personaEn: "A historian.",
        voice: "measured",
        resolvedVoiceId: "voice_designed_on_ai_studio",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: null,
      };

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
      personaEn: "A historian.",
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
      // The English persona/accent are what the voice was designed from.
      expect(hasCurrentVoice({ ...withVoice, personaEn: "A different historian." })).toBe(false);
      expect(hasCurrentVoice({ ...withVoice, accent: "French", accentEn: "French" })).toBe(false);
    });

    it("keeps a voice stored before the English fields existed valid for a person who still has none", () => {
      // Same formula as before personaEn/accentEn existed (current backend
      // version, no English suffix) — the stored voice must not be thrown away.
      const hash = createHash("sha256")
        .update("enterprise-1\u0000Omar Haddad\u0000A historian.\u0000\u0000measured")
        .digest("hex");
      const legacy: Person = { ...person, personaEn: undefined, resolvedVoiceId: "voice_x", resolvedVoiceHash: hash };
      expect(hasCurrentVoice(legacy)).toBe(true);
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
        personaEn: "A curious host.",
        voice: "warm and quick",
        resolvedVoiceId: "voice_designed_on_ai_studio",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: legacyHash,
      };

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
