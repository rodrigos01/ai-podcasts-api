import { describe, expect, it } from "vitest";
import { selectPriorEpisodes } from "../src/utils/episodeHistory";
import { buildEpisodeHistoryBlock } from "../src/llm/prompts/episodeHistory.prompts";
import type { Episode } from "../src/schemas/episode.schema";
import type { Podcast } from "../src/schemas/podcast.schema";

function episode(id: string, createdAt: number, transcript: string | null = `transcript ${id}`): Episode {
  return {
    id,
    title: `Title ${id}`,
    topics: "t",
    length: "short",
    sourceIds: [],
    participantHostIds: ["h1"],
    guests: [],
    productionNotes: "n",
    status: "ready",
    progress: null,
    transcript,
    ttsChunks: null,
    generatedAudioSeconds: 0,
    error: null,
    createdAt,
    updatedAt: createdAt + 999,
  };
}

const ids = (episodes: Episode[]) => episodes.map((e) => e.id);

describe("selectPriorEpisodes", () => {
  const all = [episode("e5", 5), episode("e1", 1), episode("e4", 4), episode("e2", 2), episode("e3", 3)];

  it("with no anchor returns the latest episodes, oldest first", () => {
    expect(ids(selectPriorEpisodes(all, undefined, 3))).toEqual(["e3", "e4", "e5"]);
  });

  it("with an anchor returns only episodes before it, never later ones", () => {
    expect(ids(selectPriorEpisodes(all, { id: "e3", createdAt: 3 }, 15))).toEqual(["e1", "e2"]);
  });

  it("caps at the N episodes immediately before the anchor, not the newest N overall", () => {
    expect(ids(selectPriorEpisodes(all, { id: "e5", createdAt: 5 }, 2))).toEqual(["e3", "e4"]);
  });

  it("breaks createdAt ties by id and never includes the anchor itself", () => {
    const tied = [episode("b", 10), episode("a", 10), episode("c", 10)];
    expect(ids(selectPriorEpisodes(tied, { id: "b", createdAt: 10 }, 15))).toEqual(["a"]);
    expect(ids(selectPriorEpisodes(tied, undefined, 15))).toEqual(["a", "b", "c"]);
  });

  it("skips episodes with no transcript", () => {
    const withGaps = [episode("e1", 1), episode("e2", 2, null), episode("e3", 3)];
    expect(ids(selectPriorEpisodes(withGaps, undefined, 15))).toEqual(["e1", "e3"]);
  });

  it("is unaffected by updatedAt (regeneration doesn't reorder)", () => {
    const regenerated = { ...episode("e1", 1), updatedAt: 9999 };
    expect(ids(selectPriorEpisodes([episode("e2", 2), regenerated], undefined, 15))).toEqual(["e1", "e2"]);
  });
});

describe("buildEpisodeHistoryBlock", () => {
  const podcast = {
    hosts: [
      { id: "h1", name: "Maya Cruz" },
      { id: "h2", name: "Camille Roy" },
    ],
  } as unknown as Podcast;

  it("is empty when there are no prior episodes", () => {
    expect(buildEpisodeHistoryBlock([], podcast)).toBe("");
  });

  it("labels each transcript with its series number, title and cast", () => {
    const block = buildEpisodeHistoryBlock(
      [{ number: 26, episode: { ...episode("e26", 26), guests: [{ name: "Dr. Lee" }] as Episode["guests"] } }],
      podcast,
    );
    expect(block).toContain("### Episode 26: Title e26 (with Maya Cruz, Dr. Lee (guest))");
    expect(block).toContain("transcript e26");
  });
});
