import { describe, expect, it } from "vitest";
import { reconcileEnglishFields } from "../src/utils/englishFields";

const stored = {
  persona: "Uma cozinheira de Recife.",
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

  it("drops a stale English field when only the original was edited", () => {
    expect(reconcileEnglishFields(stored, { ...stored, persona: "Uma chef de Olinda." })).toEqual({
      accentEn: stored.accentEn,
    });
    expect(reconcileEnglishFields(stored, { ...stored, accent: "sotaque carioca" })).toEqual({
      personaEn: stored.personaEn,
    });
  });

  it("takes a new English value the client deliberately sends", () => {
    expect(
      reconcileEnglishFields(stored, {
        ...stored,
        persona: "Uma chef de Olinda.",
        personaEn: "A chef from Olinda.",
      }),
    ).toEqual({ personaEn: "A chef from Olinda.", accentEn: stored.accentEn });
  });

  it("drops the English accent when the accent is removed", () => {
    const { accent: _a, accentEn: _ae, ...noAccent } = stored;
    expect(reconcileEnglishFields(stored, noAccent)).toEqual({ personaEn: stored.personaEn });
  });

  it("passes a brand-new person's English fields through, and never returns undefined values", () => {
    const fresh = { persona: "A host.", personaEn: "A host.", accent: undefined, accentEn: undefined };
    const result = reconcileEnglishFields(fresh, fresh);
    expect(result).toEqual({ personaEn: "A host." });
    expect(Object.keys(result)).toEqual(["personaEn"]);
  });
});
