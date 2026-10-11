import { describe, expect, it } from "vitest";
import { AUDIO_URL_TTL_SECONDS, signedEpisodeAudioUrl, verifyAudioToken } from "../src/utils/audioUrl";

const SECRET = "test-secret-test-secret-test-secret";
const NOW = 1_800_000_000_000;
const ORIGIN = "https://api.example.com";
const POD = "3f2b8c1e-9d4a-4e7b-8a61-0c5d2f9e7b34";
const EP = "a1b2c3d4-e5f6-4789-9abc-def012345678";

function tokenOf(url: string): string {
  return url.slice(`${ORIGIN}/stream/`.length);
}

describe("signedEpisodeAudioUrl", () => {
  it("builds a short /stream/<token> URL that expires after the TTL", () => {
    const { url, expiresAt } = signedEpisodeAudioUrl(ORIGIN, POD, EP, SECRET, NOW);
    expect(url).toMatch(/^https:\/\/api\.example\.com\/stream\/[A-Za-z0-9_-]{70}$/);
    expect(expiresAt).toBe(NOW / 1000 + AUDIO_URL_TTL_SECONDS);
  });

  it("refuses ids that aren't UUIDs", () => {
    expect(() => signedEpisodeAudioUrl(ORIGIN, "not-a-uuid", EP, SECRET, NOW)).toThrow();
  });
});

describe("verifyAudioToken", () => {
  const token = tokenOf(signedEpisodeAudioUrl(ORIGIN, POD, EP, SECRET, NOW).url);

  it("returns the ids it was issued for", () => {
    expect(verifyAudioToken(SECRET, token, NOW + 1000)).toEqual({ podcastId: POD, episodeId: EP });
  });

  it("is case-preserving for ids written in uppercase", () => {
    const upper = tokenOf(signedEpisodeAudioUrl(ORIGIN, POD.toUpperCase(), EP, SECRET, NOW).url);
    expect(verifyAudioToken(SECRET, upper, NOW)?.podcastId).toBe(POD);
  });

  it("rejects it once expired", () => {
    expect(verifyAudioToken(SECRET, token, NOW + (AUDIO_URL_TTL_SECONDS + 1) * 1000)).toBeNull();
  });

  it("rejects another secret and any single-character change", () => {
    expect(verifyAudioToken("another-secret-another-secret-00", token, NOW)).toBeNull();
    for (const i of [0, 20, 40, 69]) {
      const swapped = token[i] === "A" ? "B" : "A";
      expect(verifyAudioToken(SECRET, token.slice(0, i) + swapped + token.slice(i + 1), NOW)).toBeNull();
    }
  });

  it("rejects missing or malformed tokens", () => {
    expect(verifyAudioToken(SECRET, undefined, NOW)).toBeNull();
    expect(verifyAudioToken(SECRET, "", NOW)).toBeNull();
    expect(verifyAudioToken(SECRET, token.slice(1), NOW)).toBeNull();
    expect(verifyAudioToken(SECRET, `${token}A`, NOW)).toBeNull();
    expect(verifyAudioToken(SECRET, token.replace(/.$/, "+"), NOW)).toBeNull();
  });
});
