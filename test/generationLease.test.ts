import { describe, expect, it } from "vitest";
import { GENERATION_LEASE_TTL_MS } from "../src/constants/generationLease";
import {
  dependencyAction,
  GenerationSupersededError,
  isGenerationLeaseLive,
  isGenerationSuperseded,
  needsGenerationRestart,
} from "../src/utils/generationLease";

const NOW = 1_000_000;
const fresh = { owner: "a", heartbeatAt: NOW - 1_000 };
const stale = { owner: "a", heartbeatAt: NOW - GENERATION_LEASE_TTL_MS - 1 };

describe("isGenerationLeaseLive", () => {
  it("is live while the heartbeat is within the TTL", () => {
    expect(isGenerationLeaseLive(fresh, NOW)).toBe(true);
  });

  it("goes stale once the heartbeat is older than the TTL", () => {
    expect(isGenerationLeaseLive(stale, NOW)).toBe(false);
  });

  it("treats a missing or cleared lease as not live", () => {
    expect(isGenerationLeaseLive(undefined, NOW)).toBe(false);
    expect(isGenerationLeaseLive(null, NOW)).toBe(false);
  });
});

describe("needsGenerationRestart", () => {
  it("is true for an in-progress episode nobody is running", () => {
    expect(needsGenerationRestart({ status: "generating", generationLease: stale }, NOW)).toBe(true);
    expect(needsGenerationRestart({ status: "streamable", generationLease: null }, NOW)).toBe(true);
    expect(needsGenerationRestart({ status: "generating" }, NOW)).toBe(true);
  });

  it("is false while a live run holds the episode", () => {
    expect(needsGenerationRestart({ status: "generating", generationLease: fresh }, NOW)).toBe(false);
    expect(needsGenerationRestart({ status: "streamable", generationLease: fresh }, NOW)).toBe(false);
  });

  it("is false for an episode that isn't in progress, whatever its lease says", () => {
    expect(needsGenerationRestart({ status: "ready", generationLease: stale }, NOW)).toBe(false);
    expect(needsGenerationRestart({ status: "failed", generationLease: null }, NOW)).toBe(false);
  });
});

describe("dependencyAction", () => {
  it("starts once the earlier part is ready", () => {
    expect(dependencyAction({ status: "ready" })).toBe("start");
  });

  it("starts if the earlier part is gone — nothing left to wait for", () => {
    expect(dependencyAction(null)).toBe("start");
  });

  it("waits while the earlier part is still being generated", () => {
    expect(dependencyAction({ status: "generating" })).toBe("wait");
    expect(dependencyAction({ status: "streamable" })).toBe("wait");
  });

  it("fails along with an earlier part that failed", () => {
    expect(dependencyAction({ status: "failed" })).toBe("fail");
  });
});

describe("GenerationSupersededError", () => {
  it("is recognized by isGenerationSuperseded and nothing else is", () => {
    expect(isGenerationSuperseded(new GenerationSupersededError())).toBe(true);
    expect(isGenerationSuperseded(new Error("stream dropped"))).toBe(false);
    expect(isGenerationSuperseded(undefined)).toBe(false);
  });
});
