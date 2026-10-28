import { describe, expect, it, vi } from "vitest";
import { chooseContinuity, withContinuity } from "../src/services/episodeGeneration/continuity";
import { PreviousInteractionNotFoundError } from "../src/llm/geminiClient";

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
