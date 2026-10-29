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
  it("limits Style lines and tags to what can be heard, and keeps speakers within their persona's knowledge", () => {
    const { system } = render("Giles Thorne", false);
    expect(system).toContain("can be reproduced with audio alone");
    expect(system).toContain("nodding");
    expect(system).toContain("only explains what their persona, bio and experience would plausibly give them");
  });

  it("adds the natural speech rules only for podcasts that opt in", () => {
    const ep = episode("Giles Thorne");
    const ctx = (p: Podcast) => ({ podcast: p, episode: ep, sources: [], previousEpisodes: [] });
    const off = buildScriptSystemInstruction(ctx(podcast));
    const on = buildScriptSystemInstruction(ctx({ ...podcast, naturalSpeech: true }));
    expect(off).not.toContain("Natural speech");
    expect(on).toContain("Natural speech (mandatory)");
    expect(on).toContain("Follow the natural speech requirements");
    expect(buildScriptSystemInstruction(ctx({ ...podcast, naturalSpeech: false }))).toBe(off);
  });

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

  it("sets a light, conversational default tone and no per-turn sentence limit", () => {
    const { system } = render("Giles", false);
    expect(system).toContain("light and conversational");
    expect(system).toContain("only in shows that explicitly ask for it");
    expect(system).toContain("no set length for a turn");
    expect(system).not.toMatch(/one or two sentences/i);
  });

  it("keeps each speaker's knowledge to what their persona would plausibly give them", () => {
    const { system } = render("Giles", false);
    expect(system).toContain("texture");
    expect(system).toContain("plausibly have");
    expect(system).toContain("it shouldn't be said");
  });

  it("welcomes callbacks to earlier episodes without recapping or reusing them", () => {
    const { system } = render("Giles", false);
    expect(system).toContain("Callbacks");
    expect(system).toContain("not a template");
  });

  it("avoids recaps of the episode, its segments and past episodes unless the structure asks", () => {
    const { system } = render("Giles", false);
    expect(system).toContain("Avoid recaps");
    expect(system).toContain("unless the podcast structure asks for one");
  });

  it("limits angle-bracket tags to short mouth sounds, with claps as the one exception", () => {
    const { system } = render("Giles", false);
    expect(system).toContain("one or two words");
    expect(system).toContain("<claps>");
    expect(system).toContain("no stage directions");
  });

  it("offers backchanneling as optional and does not tie it to how long a turn is", () => {
    // Asking for it ("use it regularly", "whenever a turn runs past a couple of
    // sentences") made the model stretch turns to have somewhere to put one.
    const { system } = render("Giles", false);
    const section = system.slice(system.indexOf("- Backchanneling:"), system.indexOf("For Example"));
    expect(section).toContain("if you want the *other* speaker");
    expect(section).not.toMatch(/regularly|sentence|longer|runs past|long turn/i);
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

describe("script prompt history", () => {
  const ep = episode("Sayri Huamán");
  const cast = selectCast(podcast.hosts, ep.guests);
  const prior = [{ number: 1, episode: episode("Old", { transcript: "Penny: OLD-TRANSCRIPT" }) }];

  it("pastes the transcripts when the call is not chained", () => {
    const prompt = buildScriptGenerationPrompt(cast, { podcast, episode: ep, sources: [], previousEpisodes: prior }, target);
    expect(prompt).toContain("OLD-TRANSCRIPT");
    expect(prompt).toContain("Use these for continuity: the show is an ongoing series");
    expect(prompt).not.toContain("already in this conversation");
  });

  it("points at the conversation instead when chained, with the same guidance", () => {
    const prompt = buildScriptGenerationPrompt(cast, { podcast, episode: ep, sources: [], previousEpisodes: [] }, target, true);
    expect(prompt).toContain("already in this conversation");
    expect(prompt).toContain("Use them for continuity: the show is an ongoing series");
    expect(prompt).toContain("prioritize the details in the system instructions");
    expect(prompt).not.toContain("Previous episodes of this podcast");
  });

  it("says nothing about history for a show's first episode", () => {
    const prompt = buildScriptGenerationPrompt(cast, { podcast, episode: ep, sources: [], previousEpisodes: [] }, target);
    expect(prompt).not.toContain("continuity");
  });
});
