import { describe, expect, it, vi } from "vitest";
import { chooseContinuity, usesInteractionContext, withContinuity } from "../src/services/episodeGeneration/continuity";
import { PreviousInteractionNotFoundError } from "../src/llm/geminiClient";
import { selectPriorEpisodes } from "../src/utils/episodeHistory";

const ep = (interactionId?: string | null) => ({ episode: { interactionId } }) as never;

describe("chooseContinuity", () => {
  it("chains from the latest prior episode's interaction when enabled", () => {
    const prior = [ep("a"), ep("b")];
    expect(chooseContinuity(true, prior)).toEqual({ previousEpisodes: [], previousInteractionId: "b" });
  });
  it("uses transcripts when disabled", () => {
    const prior = [ep("a")];
    expect(chooseContinuity(false, prior)).toEqual({ previousEpisodes: prior });
  });
  it("uses transcripts when the head has no interaction id", () => {
    const prior = [ep("a"), ep(null)];
    expect(chooseContinuity(true, prior)).toEqual({ previousEpisodes: prior });
  });
});

describe("usesInteractionContext", () => {
  it("is on unless the podcast turns it off", () => {
    expect(usesInteractionContext({})).toBe(true);
    expect(usesInteractionContext({ useInteractionContext: true })).toBe(true);
    expect(usesInteractionContext({ useInteractionContext: false })).toBe(false);
  });
});

describe("withContinuity", () => {
  const podcast = { useInteractionContext: true } as never;
  it("falls back to transcripts when the chain is gone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const prior = [ep("x")];
    const run = vi
      .fn()
      .mockRejectedValueOnce(new PreviousInteractionNotFoundError("x"))
      .mockResolvedValueOnce("ok");
    await expect(withContinuity(podcast, prior, run)).resolves.toBe("ok");
    expect(run).toHaveBeenLastCalledWith({ previousEpisodes: prior });
  });
  it("rethrows other errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withContinuity(podcast, [ep("x")], run)).rejects.toThrow("boom");
  });
});

describe("regenerating an earlier episode", () => {
  const episode = (id: string, createdAt: number) =>
    ({ id, createdAt, transcript: "t", interactionId: `interaction-${id}` }) as never;
  const series = [episode("e1", 1), episode("e2", 2), episode("e3", 3), episode("e4", 4)];

  it("chains from the episode right before it and never sees later ones", () => {
    const prior = selectPriorEpisodes(series, { id: "e2", createdAt: 2 }, 15).map((episode, i) => ({
      number: i + 1,
      episode,
    }));
    expect(chooseContinuity(true, prior).previousInteractionId).toBe("interaction-e1");
  });

  it("the first episode has no chain to continue", () => {
    const prior = selectPriorEpisodes(series, { id: "e1", createdAt: 1 }, 15).map((episode, i) => ({
      number: i + 1,
      episode,
    }));
    expect(chooseContinuity(true, prior)).toEqual({ previousEpisodes: [] });
  });
});
