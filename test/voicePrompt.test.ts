import { describe, expect, it } from "vitest";
import type { Person } from "../src/schemas/person.schema";
import { prepareHostsForUpdate, reconcileVoicePrompt, withVoicePrompt } from "../src/utils/voicePrompt";

const base = { name: "Oliver Higgins", voice: "Homem britânico", persona: "Londrino de 35 anos." };

describe("withVoicePrompt", () => {
  it("builds it from the name and the persona as written, with an accent line when there is one", () => {
    expect(withVoicePrompt(base).voicePrompt).toBe("Name: Oliver Higgins\n\nLondrino de 35 anos.");
    expect(withVoicePrompt({ ...base, accent: "sotaque britânico" }).voicePrompt).toBe(
      "Name: Oliver Higgins\n\nLondrino de 35 anos.\n\nAccent: sotaque britânico",
    );
  });

  it("keeps an existing prompt untouched", () => {
    const person = { ...base, voicePrompt: "Name: X\n\nedited" };
    expect(withVoicePrompt(person)).toBe(person);
  });
});

describe("reconcileVoicePrompt", () => {
  const current = { ...base, voicePrompt: "Name: Oliver Higgins\n\nstored" };

  it("keeps the stored prompt when nothing it's built from changed (even if the client omitted or echoed it)", () => {
    expect(reconcileVoicePrompt(current, base)).toBe("Name: Oliver Higgins\n\nstored");
    expect(reconcileVoicePrompt(current, { ...base, voicePrompt: current.voicePrompt })).toBe(current.voicePrompt);
  });

  it("drops it when the name, persona or accent changed, so it's rebuilt", () => {
    expect(reconcileVoicePrompt(current, { ...base, name: "Ollie" })).toBeUndefined();
    expect(reconcileVoicePrompt(current, { ...base, persona: "Aposentado." })).toBeUndefined();
    expect(reconcileVoicePrompt(current, { ...base, accent: "escocês" })).toBeUndefined();
  });

  it("ignores the voice hint, which isn't part of the prompt", () => {
    const edited = { ...base, voice: "outra descrição" };
    expect(reconcileVoicePrompt(current, edited)).toBe(current.voicePrompt);
  });

  it("takes a prompt the client deliberately changed, even if the persona changed too", () => {
    expect(reconcileVoicePrompt(current, { ...base, persona: "Novo.", voicePrompt: "Name: Oliver Higgins\n\nmine" })).toBe(
      "Name: Oliver Higgins\n\nmine",
    );
  });
});

describe("prepareHostsForUpdate", () => {
  const stored: Person = {
    id: "h1",
    ...base,
    voicePrompt: "Name: Oliver Higgins\n\nstored",
    resolvedVoiceId: null,
    resolvedVoiceOrigin: null,
    resolvedVoiceHash: null,
  };

  it("keeps an untouched host's stored prompt", () => {
    const [host] = prepareHostsForUpdate([stored], [{ id: "h1", ...base }]);
    expect(host?.voicePrompt).toBe("Name: Oliver Higgins\n\nstored");
  });

  it("builds a prompt for a host stored without one (a person from before prompts were stored)", () => {
    const { voicePrompt: _dropped, ...legacy } = stored;
    const [host] = prepareHostsForUpdate([legacy as Person], [{ id: "h1", ...base }]);
    expect(host?.voicePrompt).toBe("Name: Oliver Higgins\n\nLondrino de 35 anos.");
  });

  it("rebuilds it from the new persona when the persona was edited", () => {
    const [host] = prepareHostsForUpdate([stored], [{ id: "h1", ...base, persona: "Aposentado." }]);
    expect(host?.voicePrompt).toBe("Name: Oliver Higgins\n\nAposentado.");
  });

  it("builds one for a brand-new host", () => {
    const [host] = prepareHostsForUpdate([stored], [{ name: "N", voice: "v", persona: "Nova." }]);
    expect(host?.voicePrompt).toBe("Name: N\n\nNova.");
  });
});
