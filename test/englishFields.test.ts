import { describe, expect, it } from "vitest";
import { englishSourceChanged, reconcileEnglishFields } from "../src/utils/englishFields";

const stored = {
  persona: "Uma cozinheira de Recife.",
  voice: "Mulher de 50 anos, calorosa",
  personaEn: "A cook from Recife.",
  accent: "sotaque nordestino",
  accentEn: "Northeastern Brazilian accent",
};

describe("reconcileEnglishFields", () => {
  it("keeps the stored English fields when the client doesn't know about them and nothing changed", () => {
    const { personaEn: _p, accentEn: _a, ...unaware } = stored;
    expect(reconcileEnglishFields(stored, unaware)).toEqual({
      personaEn: stored.personaEn,
      accentEn: stored.accentEn,
    });
  });

  it("keeps them when the client echoes them back unchanged", () => {
    expect(reconcileEnglishFields(stored, stored)).toEqual({
      personaEn: stored.personaEn,
      accentEn: stored.accentEn,
    });
  });

  it("drops both English fields when the persona, voice hint or accent was edited without them", () => {
    for (const edit of [
      { persona: "Uma chef de Olinda." },
      { voice: "Mulher de 40 anos, seca" },
      { accent: "sotaque carioca" },
    ]) {
      expect(reconcileEnglishFields(stored, { ...stored, ...edit })).toEqual({});
    }
  });

  it("takes a new English value the client deliberately sends, and drops the other stale one", () => {
    expect(
      reconcileEnglishFields(stored, {
        ...stored,
        persona: "Uma chef de Olinda.",
        personaEn: "A chef from Olinda.",
      }),
    ).toEqual({ personaEn: "A chef from Olinda." });
  });

  it("drops the English accent when the accent is removed", () => {
    const { accent: _a, accentEn: _ae, ...noAccent } = stored;
    expect(reconcileEnglishFields(stored, noAccent)).toEqual({});
  });

  it("keeps an accentEn that was derived from the voice hint while the accent field stays empty", () => {
    const derived = { persona: "p", voice: "v", personaEn: "pe", accentEn: "British accent" };
    expect(reconcileEnglishFields(derived, { persona: "p", voice: "v" })).toEqual({
      personaEn: "pe",
      accentEn: "British accent",
    });
  });

  it("passes a brand-new person's English fields through, and never returns undefined values", () => {
    const fresh = { persona: "A host.", voice: "v", personaEn: "A host.", accent: undefined, accentEn: undefined };
    const result = reconcileEnglishFields(fresh, fresh);
    expect(result).toEqual({ personaEn: "A host." });
    expect(Object.keys(result)).toEqual(["personaEn"]);
  });
});

describe("englishSourceChanged", () => {
  it("is true for any edit to persona, voice hint or accent, and false otherwise", () => {
    expect(englishSourceChanged(stored, { ...stored })).toBe(false);
    expect(englishSourceChanged(stored, { ...stored, personaEn: "other" })).toBe(false);
    expect(englishSourceChanged(stored, { ...stored, persona: "x" })).toBe(true);
    expect(englishSourceChanged(stored, { ...stored, voice: "x" })).toBe(true);
    expect(englishSourceChanged(stored, { ...stored, accent: undefined })).toBe(true);
  });
});
