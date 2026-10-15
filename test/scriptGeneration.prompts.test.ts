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

function render(guest: string, withHistory: boolean) {
  const ep = episode(guest);
  const cast = selectCast(podcast.hosts, ep.guests);
  const ctx = { podcast, episode: ep, sources: [], previousEpisodes: withHistory ? [{ number: 1, episode: episode("Old") }] : [] };
  return { system: buildScriptSystemInstruction(ctx), prompt: buildScriptGenerationPrompt(cast, ctx, target) };
}

describe("script prompts", () => {
  it("builds the same system instruction for every episode, whoever the guest is and whatever came before", () => {
    const first = render("Giles Thorne", false);
    const later = render("Sayri Huamán", true);
    expect(first.system).toBe(later.system);
    expect(first.system).not.toContain("Giles");
    expect(first.system).not.toContain("Sayri");
    expect(first.system).not.toContain("Previous episodes of this podcast");
  });

  it("shows no placeholder where a speaker label goes, which the model would copy literally", () => {
    const { system } = render("Giles Thorne", false);
    expect(system).not.toMatch(/\[(first|second) label\]|\[speaker\]/i);
    expect(system).toContain("no brackets");
  });

  it("tells the writer earlier episodes are not a template, catchphrases excepted", () => {
    expect(render("Giles", false).system).toContain("not a template");
    expect(render("Giles", false).system).toContain("catchphrases");
  });

  it("puts the history and the episode's speaker labels in the prompt, history first", () => {
    const { prompt } = render("Giles Thorne", true);
    expect(prompt.startsWith("Previous episodes of this podcast")).toBe(true);
    expect(prompt).toContain("prioritize the details in the system instructions");
    expect(prompt).toContain('exactly "Penny" and "Giles"');
  });

  it("has no history section for a show's first episode", () => {
    const { prompt } = render("Giles Thorne", false);
    expect(prompt.startsWith("Write the script")).toBe(true);
    expect(prompt).toContain('exactly "Penny" and "Giles"');
  });
});
