import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../src/schemas/person.schema";

vi.mock("../src/llm/geminiClient", () => ({
  generateText: vi.fn(),
}));

vi.mock("../src/llm/ttsClient", () => ({
  designVoice: vi.fn(),
  deleteVoice: vi.fn(),
  findLibraryVoice: vi.fn(),
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
import { cleanupGuestVoice, resolveGuestVoice } from "../src/services/episodeGeneration/voiceResolution.service";

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
      });

      expect(result).toEqual({
        voiceId: "custom-voice-123",
        origin: "design",
        languageCode: "en-US",
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
        languageCode: "es-AR",
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
        resolvedVoiceHash: null,
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
