import { describe, expect, it } from "vitest";
import {
  AudioCancelledError,
  abortLocalGenerations,
  abortable,
  isAudioCancelled,
  isStaleEpoch,
  trackGeneration,
  waitUntil,
} from "../src/utils/audioCancellation";

describe("local generation registry", () => {
  it("aborts every tracked generation of an episode and only that episode's", () => {
    const a = new AbortController();
    const b = new AbortController();
    const other = new AbortController();
    trackGeneration("p", "e", a);
    trackGeneration("p", "e", b);
    trackGeneration("p", "other", other);

    expect(abortLocalGenerations("p", "e")).toBe(2);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(isAudioCancelled(a.signal.reason)).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it("forgets a generation once it unregisters", () => {
    const c = new AbortController();
    const untrack = trackGeneration("p", "gone", c);
    untrack();
    expect(abortLocalGenerations("p", "gone")).toBe(0);
    expect(c.signal.aborted).toBe(false);
  });
});

describe("abortable", () => {
  it("passes the result through when not aborted", async () => {
    await expect(abortable(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
    await expect(abortable(Promise.resolve(8), undefined)).resolves.toBe(8);
  });

  it("rejects with AudioCancelledError when aborted before or while waiting", async () => {
    const early = new AbortController();
    early.abort();
    await expect(abortable(new Promise(() => {}), early.signal)).rejects.toBeInstanceOf(AudioCancelledError);

    const late = new AbortController();
    const pending = abortable(new Promise(() => {}), late.signal);
    late.abort();
    await expect(pending).rejects.toBeInstanceOf(AudioCancelledError);
  });

  it("keeps the original error when the promise fails first", async () => {
    await expect(abortable(Promise.reject(new Error("boom")), new AbortController().signal)).rejects.toThrow("boom");
  });
});

describe("waitUntil", () => {
  it("resolves true once the condition holds", async () => {
    let calls = 0;
    await expect(waitUntil(async () => ++calls >= 3, 1000, 1)).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  it("gives up with false after the timeout", async () => {
    await expect(waitUntil(async () => false, 20, 5)).resolves.toBe(false);
  });
});

describe("isStaleEpoch", () => {
  it("treats a missing stored epoch as 0", () => {
    expect(isStaleEpoch(undefined, 0)).toBe(false);
    expect(isStaleEpoch(undefined, 1)).toBe(true);
  });

  it("rejects writes made under an older epoch", () => {
    expect(isStaleEpoch(2, 1)).toBe(true);
    expect(isStaleEpoch(2, 2)).toBe(false);
  });

  it("never blocks a write that carries no epoch", () => {
    expect(isStaleEpoch(5, undefined)).toBe(false);
  });
});
