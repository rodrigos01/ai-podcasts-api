import { describe, expect, it } from "vitest";
import { buildScriptGenerationPrompt, buildScriptSystemInstruction } from "../src/llm/prompts/scriptGeneration.prompts";
import type { Episode } from "../src/schemas/episode.schema";
import type { Podcast } from "../src/schemas/podcast.schema";
import { selectCast } from "../src/services/episodeGeneration/speakerSelection";

const person = (id: string, name: string) => ({
  id, name, voice: "v", persona: `${name} persona`, resolvedVoiceId: null, resolvedVoiceOrigin: null, resolvedVoiceHash: null,
});
const podcast: Podcast = {
  id: "p", title: "Show", description: "d", structure: "s", hosts: [person("h1", "Penny Hart")], ownerId: "o", createdAt: 1, updatedAt: 1,
};
const episode = (guest: string, extra: Partial<Episode> = {}): Episode => ({
  id: guest, title: `With ${guest}`, topics: "t", length: "medium", sourceIds: [], participantHostIds: ["h1"],
  guests: [person(`g-${guest}`, guest)], status: "ready", progress: null, transcript: "Penny: hello", ttsChunks: null,
  generatedAudioSeconds: 0, error: null, createdAt: 1, updatedAt: 1, ...extra,
});
const target = { min: 100, max: 200 };

function render(p: Podcast, guest: string, extra: { pastNotes?: string } = {}) {
  const ep = episode(guest);
  const cast = selectCast(p.hosts, ep.guests);
  const ctx = { podcast: p, episode: ep, sources: [], previousEpisodes: extra.pastNotes ? [] : [{ number: 1, episode: episode("Old") }], ...extra };
  return { system: buildScriptSystemInstruction(cast, ctx), prompt: buildScriptGenerationPrompt(cast, ctx, target) };
}

describe("history placement", () => {
  const inPrompt: Podcast = { ...podcast, historyPlacement: "prompt" };

  it("keeps the history and labels in the system instruction by default", () => {
    const { system, prompt } = render(podcast, "Giles Thorne");
    expect(system).toContain("Previous episodes of this podcast");
    expect(system).toContain('exactly "Penny" and "Giles"');
    expect(prompt).not.toContain("Previous episodes of this podcast");
  });

  it("leaves the system instruction identical for every episode when the history is in the prompt", () => {
    const a = render(inPrompt, "Giles Thorne");
    const b = render(inPrompt, "Sayri Huamán", { pastNotes: "- Episode 1: Penny said X." });
    expect(a.system).toBe(b.system);
    expect(a.system).not.toContain("Previous episodes of this podcast");
    // No placeholder for the model to copy into its labels.
    expect(a.system).not.toMatch(/\[(first|second) label\]/);
    expect(a.system).not.toContain("Penny:");
    expect(a.system).toContain("no brackets");
    expect(a.prompt).toContain("Previous episodes of this podcast");
    expect(a.prompt).toContain('exactly "Penny" and "Giles"');
    expect(b.prompt).toContain("not a checklist");
    expect(b.prompt).toContain('exactly "Penny" and "Sayri"');
  });

  it("adds the not-a-template rule to the system instruction only when asked", () => {
    expect(render(inPrompt, "Giles").system).not.toContain("not a template");
    expect(render({ ...inPrompt, historyTemplateRule: true }, "Giles").system).toContain("not a template");
  });
});
