import { describe, expect, it } from "vitest";
import { needsContinuityNotes } from "../src/utils/continuityNotes";
import { continuityNotesPrompt, continuityNotesSystemInstruction } from "../src/llm/prompts/continuityNotes.prompts";
import type { Episode } from "../src/schemas/episode.schema";
import type { Podcast } from "../src/schemas/podcast.schema";

describe("needsContinuityNotes", () => {
  it("never needs them when there is nothing earlier to read", () => {
    expect(needsContinuityNotes({}, 0)).toBe(false);
    expect(needsContinuityNotes({ startsAfterEpisodeId: "part-1" }, 0)).toBe(false);
  });
  it("writes them for an episode that has none, so a regenerate keeps the series", () => {
    expect(needsContinuityNotes({}, 3)).toBe(true);
  });
  it("leaves an episode's own notes alone", () => {
    expect(needsContinuityNotes({ continuityNotes: "Episode 1: ..." }, 3)).toBe(false);
  });
  it("rewrites the notes of a later part of a split, drafted before the part before it had a transcript", () => {
    expect(needsContinuityNotes({ continuityNotes: "Episode 1: ...", startsAfterEpisodeId: "part-1" }, 3)).toBe(true);
  });
});

describe("notes-only call prompts", () => {
  const podcast = {
    id: "p", title: "Show", description: "desc", structure: "struct",
    hosts: [{ name: "Penny", persona: "p" }],
  } as unknown as Podcast;
  const prior = [
    { number: 1, episode: { id: "e1", title: "One", transcript: "Penny: PART-ONE-LINE", participantHostIds: [], guests: [] } },
  ] as never;
  const episode = {
    title: "Part 2", topics: "t", productionNotes: "second half", guests: [{ name: "Giles", persona: "a tea man" }],
  } as unknown as Episode;

  it("gives the call the earlier transcripts and the same notes rules the draft call gets", () => {
    const system = continuityNotesSystemInstruction(podcast, prior);
    expect(system).toContain("PART-ONE-LINE");
    expect(system).toContain("Your only job is to write its continuity notes");
    expect(system).toContain("The show's formula");
    expect(system).toContain("never tell the hosts or the guest what to do with it");
  });

  it("describes the drafted episode and its sources", () => {
    const prompt = continuityNotesPrompt(episode, [{ title: "Diary", contents: "Day one" } as never]);
    expect(prompt).toContain("### Diary\nDay one");
    expect(prompt).toContain("Title: Part 2");
    expect(prompt).toContain("Production notes: second half");
    expect(prompt).toContain("Guest: Giles: a tea man");
  });
});
