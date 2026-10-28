import { describe, expect, it } from "vitest";
import { planRegeneration } from "../src/utils/regenerationPlan";

describe("planRegeneration", () => {
  it("runs episodes in series order, each behind the one before", () => {
    const plan = planRegeneration([
      { id: "c", createdAt: 30 },
      { id: "a", createdAt: 10 },
      { id: "b", createdAt: 20 },
    ]);
    expect(plan).toEqual([{ id: "a" }, { id: "b", startsAfterEpisodeId: "a" }, { id: "c", startsAfterEpisodeId: "b" }]);
  });

  it("breaks createdAt ties by id, like the history window does", () => {
    const plan = planRegeneration([
      { id: "z", createdAt: 5 },
      { id: "m", createdAt: 5 },
    ]);
    expect(plan.map((step) => step.id)).toEqual(["m", "z"]);
    expect(plan[1]?.startsAfterEpisodeId).toBe("m");
  });

  it("a single episode has nothing to wait for", () => {
    expect(planRegeneration([{ id: "a", createdAt: 1 }])).toEqual([{ id: "a" }]);
  });

  it("does not modify its input", () => {
    const input = [
      { id: "b", createdAt: 2 },
      { id: "a", createdAt: 1 },
    ];
    planRegeneration(input);
    expect(input.map((e) => e.id)).toEqual(["b", "a"]);
  });
});
