import { describe, expect, it } from "vitest";
import { AUDIO_URL_TTL_SECONDS, signedEpisodeAudioUrl, verifyAudioSignature } from "../src/utils/audioUrl";

const SECRET = "test-secret-test-secret-test-secret";
const NOW = 1_800_000_000_000;
const ORIGIN = "https://api.example.com";

function params(url: string) {
  const q = new URL(url).searchParams;
  return { exp: q.get("exp"), sig: q.get("sig") };
}

describe("signedEpisodeAudioUrl", () => {
  it("builds the public audio URL with an expiry and signature", () => {
    const { url, expiresAt } = signedEpisodeAudioUrl(ORIGIN, "pod1", "ep1", SECRET, NOW);
    expect(url.startsWith("https://api.example.com/podcasts/pod1/episodes/ep1/audio?exp=")).toBe(true);
    expect(expiresAt).toBe(NOW / 1000 + AUDIO_URL_TTL_SECONDS);
  });
});

describe("verifyAudioSignature", () => {
  const { url } = signedEpisodeAudioUrl(ORIGIN, "pod1", "ep1", SECRET, NOW);
  const { exp, sig } = params(url);

  it("accepts a fresh URL for the same ids", () => {
    expect(verifyAudioSignature(SECRET, "pod1", "ep1", exp, sig, NOW + 1000)).toBe(true);
  });

  it("rejects it once expired", () => {
    const after = NOW + (AUDIO_URL_TTL_SECONDS + 1) * 1000;
    expect(verifyAudioSignature(SECRET, "pod1", "ep1", exp, sig, after)).toBe(false);
  });

  it("rejects other ids, another secret, a tampered expiry or signature", () => {
    expect(verifyAudioSignature(SECRET, "pod1", "ep2", exp, sig, NOW)).toBe(false);
    expect(verifyAudioSignature(SECRET, "pod2", "ep1", exp, sig, NOW)).toBe(false);
    expect(verifyAudioSignature("another-secret-another-secret-00", "pod1", "ep1", exp, sig, NOW)).toBe(false);
    expect(verifyAudioSignature(SECRET, "pod1", "ep1", String(Number(exp) + 3600), sig, NOW)).toBe(false);
    expect(verifyAudioSignature(SECRET, "pod1", "ep1", exp, `${sig}x`, NOW)).toBe(false);
  });

  it("rejects missing or malformed parameters", () => {
    expect(verifyAudioSignature(SECRET, "pod1", "ep1", undefined, undefined, NOW)).toBe(false);
    expect(verifyAudioSignature(SECRET, "pod1", "ep1", ["1"], sig, NOW)).toBe(false);
    expect(verifyAudioSignature(SECRET, "pod1", "ep1", "-5", sig, NOW)).toBe(false);
    expect(verifyAudioSignature(SECRET, "pod1", "ep1", "abc", sig, NOW)).toBe(false);
  });
});
