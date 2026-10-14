import { describe, expect, it } from "vitest";
import { buildPastNotesBlock, buildPastNotesPrompt } from "../src/llm/prompts/pastNotes.prompts";
import { buildScriptSystemInstruction } from "../src/llm/prompts/scriptGeneration.prompts";
import type { Episode } from "../src/schemas/episode.schema";
import type { Podcast } from "../src/schemas/podcast.schema";
import type { Source } from "../src/schemas/source.schema";
import { selectCast } from "../src/services/episodeGeneration/speakerSelection";

const person = (id: string, name: string) => ({
  id, name, voice: "v", persona: `${name} persona`, resolvedVoiceId: null, resolvedVoiceOrigin: null, resolvedVoiceHash: null,
});
const podcast: Podcast = {
  id: "p", title: "Show", description: "d", structure: "s", hosts: [person("h1", "Penny")], ownerId: "o", createdAt: 1, updatedAt: 1,
};
const episode = (id: string, extra: Partial<Episode> = {}): Episode => ({
  id, title: `Title ${id}`, topics: `topics ${id}`, length: "medium", sourceIds: ["s1"], participantHostIds: ["h1"],
  guests: [person("g1", "Giles")], status: "ready", progress: null, transcript: `transcript ${id}`, ttsChunks: null,
  generatedAudioSeconds: 0, error: null, createdAt: 1, updatedAt: 1, ...extra,
});
const source = (id: string, title: string): Source => ({ id, title, contents: `contents of ${title}`, sourceType: "text", createdAt: 1 });

describe("buildPastNotesPrompt", () => {
  const shared = source("s1", "Shared");
  const pastOnly = source("s2", "Past only");
  const prompt = buildPastNotesPrompt(
    podcast,
    episode("up", { sourceIds: ["s1"], transcript: null }),
    [shared],
    [
      { number: 1, episode: episode("a", { sourceIds: ["s2"] }) },
      { number: 2, episode: episode("b", { sourceIds: ["s1"] }) },
    ],
    new Map([["s1", shared], ["s2", pastOnly]]),
  );

  it("labels each earlier episode with its number, cast and sources", () => {
    expect(prompt).toContain("### Episode 1: Title a\nCast: Penny (host), Giles (guest)\nSource material used: \"Past only\"");
    expect(prompt).toContain("### Episode 2: Title b");
  });

  it("prints a source the upcoming episode also uses once, under the upcoming episode", () => {
    expect(prompt.match(/contents of Shared/g)).toHaveLength(1);
    expect(prompt.indexOf("contents of Shared")).toBeGreaterThan(prompt.indexOf("# The upcoming episode"));
    expect(prompt.indexOf("contents of Past only")).toBeLessThan(prompt.indexOf("# The upcoming episode"));
  });
});

describe("script instruction with notes", () => {
  it("frames the notes as an inventory, not a checklist, and prefers them over transcripts", () => {
    const ep = episode("up", { transcript: null });
    const cast = selectCast(podcast.hosts, ep.guests);
    const withNotes = buildScriptSystemInstruction(cast, {
      podcast, episode: ep, sources: [], pastNotes: "- Episode 1: Penny said X.",
      previousEpisodes: [{ number: 1, episode: episode("a") }],
    });
    expect(withNotes).toContain("- Episode 1: Penny said X.");
    expect(withNotes).toContain("not a checklist");
    expect(withNotes).not.toContain("full transcripts");
    expect(buildPastNotesBlock("n")).toContain("nothing in them needs to be called back");
  });
});
