import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../src/schemas/person.schema";

vi.mock("../src/llm/geminiClient", () => ({ generateText: vi.fn() }));

import { generateText } from "../src/llm/geminiClient";
import {
  hasEnglishFields,
  prepareHostsForUpdate,
  withEnglishFields,
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
  });
});
