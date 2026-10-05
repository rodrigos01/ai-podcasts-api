import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../src/schemas/person.schema";

vi.mock("../src/llm/geminiClient", () => ({ generateText: vi.fn() }));

import { generateText } from "../src/llm/geminiClient";
import {
  hasEnglishFields,
  prepareHostsForUpdate,
  withEnglishFields,
  withVoicePrompt,
} from "../src/services/personEnglish.service";

const base = { name: "Oliver Higgins", voice: "Homem britânico, sotaque britânico ao falar português", persona: "Londrino de 35 anos." };

describe("personEnglish.service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("hasEnglishFields", () => {
    it("needs a persona, and an English accent only when an accent is set", () => {
      expect(hasEnglishFields({})).toBe(false);
      expect(hasEnglishFields({ personaEn: "x" })).toBe(true);
      expect(hasEnglishFields({ personaEn: "x", accent: "a" })).toBe(false);
      expect(hasEnglishFields({ personaEn: "x", accent: "a", accentEn: "b" })).toBe(true);
    });
  });

  describe("withVoicePrompt", () => {
    it("keeps an existing prompt untouched", async () => {
      const person = { ...base, voicePrompt: "Name: X\n\nedited" };
      expect(await withVoicePrompt(person)).toBe(person);
      expect(generateText).not.toHaveBeenCalled();
    });

    it("builds it from name, English persona and English accent", async () => {
      const result = await withVoicePrompt({ ...base, personaEn: "A Londoner.", accent: "x", accentEn: "British" });
      expect(result.voicePrompt).toBe("Name: Oliver Higgins\n\nA Londoner.\n\nAccent: British");
      expect(generateText).not.toHaveBeenCalled();
    });

    it("writes the English fields first when they're missing", async () => {
      vi.mocked(generateText).mockResolvedValueOnce({ personaEn: "A Londoner." });
      const result = await withVoicePrompt(base);
      expect(result).toMatchObject({ personaEn: "A Londoner.", voicePrompt: "Name: Oliver Higgins\n\nA Londoner." });
    });

    it("falls back to the original persona and accent if translation fails", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(new Error("boom"));
      const result = await withVoicePrompt({ ...base, accent: "sotaque" });
      expect(result.voicePrompt).toBe(`Name: Oliver Higgins\n\n${base.persona}\n\nAccent: sotaque`);
    });
  });

  describe("withEnglishFields", () => {
    it("leaves a person that already has English fields alone, with no LLM call", async () => {
      const person = { ...base, personaEn: "A 35-year-old Londoner." };
      expect(await withEnglishFields(person)).toBe(person);
      expect(generateText).not.toHaveBeenCalled();
    });

    it("writes the English persona and an accent taken from the voice hint when the accent field is empty", async () => {
      vi.mocked(generateText).mockResolvedValueOnce({
        personaEn: "A 35-year-old Londoner.",
        accentEn: "British accent when speaking Portuguese",
      });

      const result = await withEnglishFields(base);

      expect(result).toEqual({
        ...base,
        personaEn: "A 35-year-old Londoner.",
        accentEn: "British accent when speaking Portuguese",
      });
      // The voice hint is what the model reads the accent from.
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringContaining("Voice hint: Homem britânico") }),
      );
    });

    it("omits accentEn entirely, rather than setting undefined, when no accent is stated", async () => {
      vi.mocked(generateText).mockResolvedValueOnce({ personaEn: "A host." });
      const result = await withEnglishFields({ name: "B", voice: "v", persona: "Uma anfitriã." });
      expect(Object.keys(result).sort()).toEqual(["name", "persona", "personaEn", "voice"]);
    });

    it("replaces stale English fields instead of leaving them behind", async () => {
      vi.mocked(generateText).mockResolvedValueOnce({ personaEn: "New." });
      const result = await withEnglishFields({ ...base, accent: "sotaque", accentEn: undefined, personaEn: "Old." });
      expect(result.personaEn).toBe("New.");
      expect(result).not.toHaveProperty("accentEn");
    });

    it("saves the person unchanged if the call fails", async () => {
      vi.mocked(generateText).mockRejectedValueOnce(new Error("boom"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await withEnglishFields(base)).toBe(base);
    });
  });

  describe("prepareHostsForUpdate", () => {
    const stored: Person = {
      id: "h1",
      ...base,
      personaEn: "A 35-year-old Londoner.",
      accentEn: "British accent when speaking Portuguese",
      resolvedVoiceId: "voice_x",
      resolvedVoiceOrigin: "design",
      resolvedVoiceHash: "hash",
    };

    it("leaves an untouched host exactly as stored — no call, English fields kept", async () => {
      const [host] = await prepareHostsForUpdate([stored], [{ id: "h1", ...base }]);
      expect(generateText).not.toHaveBeenCalled();
      expect(host).toEqual({
        id: "h1",
        ...base,
        personaEn: stored.personaEn,
        accentEn: stored.accentEn,
        // Built from the stored English fields — no LLM call needed.
        voicePrompt: expect.stringContaining("Name: Oliver Higgins"),
      });
    });

    it("does not add English fields to an untouched legacy host (that would change its voice hash)", async () => {
      const legacy: Person = { ...stored, personaEn: undefined, accentEn: undefined };
      const [host] = await prepareHostsForUpdate([legacy], [{ id: "h1", ...base }]);
      expect(generateText).not.toHaveBeenCalled();
      expect(host).toEqual({ id: "h1", ...base });
    });

    it("writes fresh English fields for a host whose persona was edited", async () => {
      vi.mocked(generateText).mockResolvedValueOnce({ personaEn: "A retired Londoner." });
      const [host] = await prepareHostsForUpdate([stored], [{ id: "h1", ...base, persona: "Londrino aposentado." }]);
      expect(host).toMatchObject({ id: "h1", personaEn: "A retired Londoner." });
      expect(host).not.toHaveProperty("accentEn");
    });

    it("writes English fields for a brand-new host", async () => {
      vi.mocked(generateText).mockResolvedValueOnce({ personaEn: "A new host." });
      const [host] = await prepareHostsForUpdate([stored], [{ name: "N", voice: "v", persona: "Nova." }]);
      expect(host).toMatchObject({ personaEn: "A new host." });
    });

    describe("voice prompt", () => {
      const withPrompt: Person = { ...stored, voicePrompt: "Name: Oliver Higgins\n\nstored prompt" };

      it("keeps the stored prompt when nothing it's built from changed", async () => {
        const [host] = await prepareHostsForUpdate([withPrompt], [{ id: "h1", ...base }]);
        expect(host?.voicePrompt).toBe("Name: Oliver Higgins\n\nstored prompt");
      });

      it("rebuilds it from the existing English fields, without an LLM call, when the name changed", async () => {
        const [host] = await prepareHostsForUpdate([withPrompt], [{ id: "h1", ...base, name: "Ollie Higgins" }]);
        expect(generateText).not.toHaveBeenCalled();
        expect(host?.voicePrompt).toMatch(/^Name: Ollie Higgins/);
      });

      it("rebuilds it after fresh English fields when the persona changed", async () => {
        vi.mocked(generateText).mockResolvedValueOnce({ personaEn: "A retired Londoner." });
        const [host] = await prepareHostsForUpdate(
          [withPrompt],
          [{ id: "h1", ...base, persona: "Londrino aposentado." }],
        );
        expect(host?.voicePrompt).toBe("Name: Oliver Higgins\n\nA retired Londoner.");
      });

      it("takes a prompt the client deliberately changed, even if the persona changed too", async () => {
        vi.mocked(generateText).mockResolvedValueOnce({ personaEn: "A retired Londoner." });
        const [host] = await prepareHostsForUpdate(
          [withPrompt],
          [{ id: "h1", ...base, persona: "Londrino aposentado.", voicePrompt: "Name: Oliver Higgins\n\nmine" }],
        );
        expect(host?.voicePrompt).toBe("Name: Oliver Higgins\n\nmine");
      });
    });
  });
});
