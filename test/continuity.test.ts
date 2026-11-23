import { describe, expect, it, vi } from "vitest";
import { chainHead, withContinuity, type ContinuityDeps } from "../src/services/episodeGeneration/continuity";
import { PreviousInteractionNotFoundError } from "../src/llm/geminiClient";
import { episodesAfter, selectPriorEpisodes } from "../src/utils/episodeHistory";
import type { Podcast } from "../src/schemas/podcast.schema";

const podcast = (useInteractionContext?: boolean) =>
  ({ id: "p", title: "Show", ...(useInteractionContext === undefined ? {} : { useInteractionContext }) }) as Podcast;

const episode = (id: string, createdAt: number, interactionId: string | null = `interaction-${id}`) =>
  ({ id, createdAt, transcript: `transcript ${id}`, interactionId }) as never;
const prior = (...episodes: ReturnType<typeof episode>[]) => episodes.map((e, i) => ({ number: i + 1, episode: e }));

function deps(overrides: Partial<ContinuityDeps> = {}): ContinuityDeps & {
  catchUp: ReturnType<typeof vi.fn>;
  remember: ReturnType<typeof vi.fn>;
} {
  return {
    catchUp: vi.fn().mockResolvedValue("caught-up"),
    remember: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

describe("chainHead", () => {
  it("is the latest earlier episode's interaction", () => {
    expect(chainHead(prior(episode("a", 1), episode("b", 2)))).toBe("interaction-b");
  });
  it("is null without earlier episodes or when the latest has none", () => {
    expect(chainHead([])).toBeNull();
    expect(chainHead(prior(episode("a", 1), episode("b", 2, null)))).toBeNull();
  });
});

describe("withContinuity", () => {
  const history = prior(episode("a", 1), episode("b", 2));

  it("continues the head's interaction when it has one", async () => {
    const d = deps();
    const run = vi.fn().mockResolvedValue("ok");
    await expect(withContinuity(podcast(), history, run, d)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledWith({ previousEpisodes: [], previousInteractionId: "interaction-b" });
    expect(d.catchUp).not.toHaveBeenCalled();
  });

  it("sends the transcripts in the prompt when the podcast opts out, and for a first episode", async () => {
    const d = deps();
    const run = vi.fn().mockResolvedValue("ok");
    await withContinuity(podcast(false), history, run, d);
    expect(run).toHaveBeenLastCalledWith({ previousEpisodes: history });
    await withContinuity(podcast(), [], run, d);
    expect(run).toHaveBeenLastCalledWith({ previousEpisodes: [] });
    expect(d.catchUp).not.toHaveBeenCalled();
  });

  it("catches the series up and saves the result when the head has no interaction", async () => {
    const stale = prior(episode("a", 1), episode("b", 2, null));
    const d = deps();
    const run = vi.fn().mockResolvedValue("ok");
    await withContinuity(podcast(), stale, run, d);
    expect(d.catchUp).toHaveBeenCalledWith(podcast(), stale);
    expect(d.remember).toHaveBeenCalledWith("p", stale[1]!.episode, "caught-up");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ previousEpisodes: [], previousInteractionId: "caught-up" });
  });

  it("catches up again when the head's interaction has expired", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new PreviousInteractionNotFoundError("interaction-b"))
      .mockResolvedValueOnce("ok");
    await expect(withContinuity(podcast(), history, run, d)).resolves.toBe("ok");
    expect(d.catchUp).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith({ previousEpisodes: [], previousInteractionId: "caught-up" });
  });

  it("falls back to the transcripts in the prompt if the catch-up fails, and still runs if saving fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = deps({ catchUp: vi.fn().mockRejectedValue(new Error("down")) });
    const run = vi.fn().mockResolvedValue("ok");
    const stale = prior(episode("a", 1, null));
    await withContinuity(podcast(), stale, run, failing);
    expect(run).toHaveBeenLastCalledWith({ previousEpisodes: stale });

    const unsaved = deps({ remember: vi.fn().mockRejectedValue(new Error("write failed")) });
    await withContinuity(podcast(), stale, run, unsaved);
    expect(run).toHaveBeenLastCalledWith({ previousEpisodes: [], previousInteractionId: "caught-up" });
  });

  it("rethrows other errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withContinuity(podcast(), history, run, deps())).rejects.toThrow("boom");
  });
});

describe("regenerating an earlier episode", () => {
  const series = [episode("e1", 1), episode("e2", 2), episode("e3", 3), episode("e4", 4)];
  const priorOf = (id: string, createdAt: number) =>
    selectPriorEpisodes(series, { id, createdAt }, 15).map((e, i) => ({ number: i + 1, episode: e }));

  it("continues from the episode right before it and never sees later ones", () => {
    expect(chainHead(priorOf("e2", 2))).toBe("interaction-e1");
  });

  it("the first episode has no chain to continue", () => {
    expect(chainHead(priorOf("e1", 1))).toBeNull();
  });

  it("forgets exactly the interactions of the episodes after it", () => {
    expect(episodesAfter(series, { id: "e2", createdAt: 2 }).map((e) => e.id)).toEqual(["e3", "e4"]);
    expect(episodesAfter(series, { id: "e4", createdAt: 4 })).toEqual([]);
  });
});
