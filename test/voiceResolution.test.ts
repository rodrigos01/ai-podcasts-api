import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { voiceHash } from "../src/utils/voiceHash";
import type { Person } from "../src/schemas/person.schema";

vi.mock("../src/llm/geminiClient", () => ({
  generateText: vi.fn(),
}));

vi.mock("../src/llm/ttsClient", () => ({
  designVoice: vi.fn(),
  deleteVoice: vi.fn(),
}));

vi.mock("../src/data/voiceUsage.repository", () => ({ findVoicesInUse: vi.fn(async () => new Set<string>()) }));

vi.mock("../src/data/episode.repository", () => ({
  getEpisode: vi.fn(),
  listDependentEpisodes: vi.fn(),
  shareGuestVoice: vi.fn(),
  setGuestResolvedVoice: vi.fn(),
  setGuestVoicePrompt: vi.fn(),
}));

vi.mock("../src/data/podcast.repository", () => ({
  setHostResolvedVoice: vi.fn(),
  setHostVoicePrompt: vi.fn(),
}));

import { generateText } from "../src/llm/geminiClient";
import { deleteVoice, designVoice } from "../src/llm/ttsClient";
import { getEpisode, listDependentEpisodes, setGuestResolvedVoice, shareGuestVoice, setGuestVoicePrompt } from "../src/data/episode.repository";
import { setHostResolvedVoice, setHostVoicePrompt } from "../src/data/podcast.repository";
import { cleanupGuestVoice, otherSplitParts, hasCurrentVoice, resolveGuestVoice, resolveHostVoice } from "../src/services/episodeGeneration/voiceResolution.service";

describe("voiceResolution.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveGuestVoice", () => {
    it("builds the prompt from the name and persona as written when it has none, with no accent line", async () => {
      const guest: Person = {
        id: "guest-1",
        name: "Dr. Evelyn Reed",
        persona: "A marine biologist passionate about deep-sea exploration.",
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

    it("designs from the stored voicePrompt as-is, with no LLM call and nothing re-persisted", async () => {
      vi.mocked(designVoice).mockResolvedValueOnce("v-stored");
      await resolveGuestVoice("pod-1", "ep-1", {
        id: "g",
        name: "G",
        persona: "x",
        voice: "v",
        voicePrompt: "Name: G\n\nSomething the client edited.",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      });
      expect(generateText).not.toHaveBeenCalled();
      expect(setGuestVoicePrompt).not.toHaveBeenCalled();
      expect(designVoice).toHaveBeenCalledWith({ voiceDescription: "Name: G\n\nSomething the client edited." });
    });

    it("designs for the podcast's language when it has one, and without one otherwise", async () => {
      const guest: Person = {
        id: "g",
        name: "G",
        persona: "x",
        voice: "v",
        voicePrompt: "Name: G\n\nbio",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      };
      vi.mocked(designVoice).mockResolvedValue("v-lang");
      await resolveGuestVoice("pod-1", "ep-1", guest, "pt-BR");
      expect(designVoice).toHaveBeenLastCalledWith({ voiceDescription: "Name: G\n\nbio", languageCode: "pt-BR" });
      await resolveGuestVoice("pod-1", "ep-1", guest);
      expect(vi.mocked(designVoice).mock.lastCall?.[0]).not.toHaveProperty("languageCode");
    });

    it("writes the prompt to the guest before designing when it has none", async () => {
      vi.mocked(designVoice).mockResolvedValueOnce("v-new");
      await resolveGuestVoice("pod-1", "ep-1", {
        id: "g",
        name: "G",
        persona: "Una anfitriona.",
        voice: "v",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      });
      expect(setGuestVoicePrompt).toHaveBeenCalledWith("pod-1", "ep-1", "g", "Name: G\n\nUna anfitriona.");
      expect(vi.mocked(setGuestVoicePrompt).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(designVoice).mock.invocationCallOrder[0] as number,
      );
    });

    it("sends the persona and accent in the show's own language, untranslated, with the podcast's language code", async () => {
      const guest: Person = {
        id: "guest-2",
        name: "Jessica Miller",
        persona: "Jessica Miller, 35, uma americana de Boston que mora no Brasil há cinco anos.",
        voice: "simpática, pausada",
        accent: "sotaque americano marcado ao falar português",
        resolvedVoiceId: null,
        resolvedVoiceOrigin: null,
        resolvedVoiceHash: null,
      };
      vi.mocked(designVoice).mockResolvedValueOnce("custom-voice-456");

      await resolveGuestVoice("pod-1", "ep-1", guest, "pt-BR");

      expect(generateText).not.toHaveBeenCalled();
      expect(designVoice).toHaveBeenCalledWith({
        voiceDescription:
          "Name: Jessica Miller\n\nJessica Miller, 35, uma americana de Boston que mora no Brasil há cinco anos.\n\n" +
          "Accent: sotaque americano marcado ao falar português",
        languageCode: "pt-BR",
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
      expect(hasCurrentVoice({ ...withVoice, accent: "French" })).toBe(false);
    });

    it("keeps a voice valid under the current hash formula", () => {
      // The formula is part of every stored voice's identity — changing it
      // re-designs everyone's voice, so it's pinned here.
      const hash = createHash("sha256")
        .update("enterprise-1\u0000Omar Haddad\u0000A historian.\u0000\u0000measured")
        .digest("hex");
      const stored: Person = { ...person, resolvedVoiceId: "voice_x", resolvedVoiceHash: hash };
      expect(hasCurrentVoice(stored)).toBe(true);
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

  describe("a guest repeated across the parts of a split", () => {
    const part1Guest = (): Person => {
      const base = { id: "g1", name: "Sarah Chen", persona: "AI researcher.", voice: "calm" };
      return {
        ...base,
        resolvedVoiceId: "voice_part1",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: voiceHash(base),
      };
    };
    const part2Guest = (): Person => ({
      id: "g2",
      name: "Sarah Chen",
      persona: "AI researcher.",
      voice: "calm",
      resolvedVoiceId: null,
      resolvedVoiceOrigin: null,
      resolvedVoiceHash: null,
    });

    const part = (id: string, guest: Person) => ({ id, guests: [guest] });

    it("reuses a voice another part already has instead of designing another", async () => {
      const result = await resolveGuestVoice("pod-1", "ep-2", part2Guest(), undefined, [part("ep-1", part1Guest())]);

      expect(designVoice).not.toHaveBeenCalled();
      expect(result).toEqual({ voiceId: "voice_part1", origin: "design" });
      expect(setGuestResolvedVoice).toHaveBeenCalledWith("pod-1", "ep-2", "g2", {
        resolvedVoiceId: "voice_part1",
        resolvedVoiceOrigin: "design",
        resolvedVoiceHash: voiceHash(part2Guest()),
      });
    });

    it("designs a voice and copies it into the other parts when it resolves first", async () => {
      vi.mocked(designVoice).mockResolvedValue("voice_first");

      await resolveGuestVoice("pod-1", "ep-1", part2Guest(), undefined, [part("ep-2", part2Guest())]);

      expect(designVoice).toHaveBeenCalledTimes(1);
      expect(shareGuestVoice).toHaveBeenCalledTimes(1);
      const [podcastId, episodeId, wants, resolved] = vi.mocked(shareGuestVoice).mock.calls[0]!;
      expect([podcastId, episodeId]).toEqual(["pod-1", "ep-2"]);
      expect(resolved).toMatchObject({ resolvedVoiceId: "voice_first", resolvedVoiceOrigin: "design" });
      // It only fills in the same guest, and only one without a usable voice.
      expect(wants(part2Guest())).toBe(true);
      expect(wants({ ...part2Guest(), persona: "A chef." })).toBe(false);
      expect(wants(part1Guest())).toBe(false);
    });

    it("designs its own when no other part has a usable voice for this guest", async () => {
      vi.mocked(designVoice).mockResolvedValue("voice_new");
      const noVoice: Person = { ...part1Guest(), resolvedVoiceId: null, resolvedVoiceHash: null };
      const other: Person = { ...part1Guest(), persona: "A chef." };

      await resolveGuestVoice("pod-1", "ep-2", part2Guest(), undefined, [part("ep-1", noVoice)]);
      await resolveGuestVoice("pod-1", "ep-2", part2Guest(), undefined, [part("ep-1", other)]);

      expect(designVoice).toHaveBeenCalledTimes(2);
    });

    it("doesn't delete its own stored voice when that is the shared one", async () => {
      const again: Person = { ...part2Guest(), resolvedVoiceId: "voice_part1", resolvedVoiceOrigin: "design", resolvedVoiceHash: "h" };
      await resolveGuestVoice("pod-1", "ep-2", again, undefined, [part("ep-1", part1Guest())]);
      expect(deleteVoice).not.toHaveBeenCalled();
    });

    it("otherSplitParts walks the startsAfterEpisodeId links both ways", async () => {
      const ep = (id: string, startsAfterEpisodeId?: string) =>
        ({ id, guests: [], ...(startsAfterEpisodeId ? { startsAfterEpisodeId } : {}) }) as never;
      // ep-1 <- ep-2 <- ep-3, asked from the middle.
      vi.mocked(getEpisode).mockImplementation(async (_p, id) => (id === "ep-1" ? ep("ep-1") : null));
      vi.mocked(listDependentEpisodes).mockImplementation(async (_p, id) => (id === "ep-2" ? [ep("ep-3", "ep-2")] : []));

      const parts = await otherSplitParts("pod-1", { id: "ep-2", startsAfterEpisodeId: "ep-1" });

      expect(parts.map((p) => p.id).sort()).toEqual(["ep-1", "ep-3"]);
      vi.mocked(listDependentEpisodes).mockResolvedValue([]);
      expect(await otherSplitParts("pod-1", { id: "solo" })).toEqual([]);
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
