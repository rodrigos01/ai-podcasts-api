import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How long a signed audio URL stays valid. Long enough for a full episode plus
 * pauses and a cast receiver re-requesting on seek; clients fetch a fresh one
 * from GET .../audio/url when it lapses.
 */
export const AUDIO_URL_TTL_SECONDS = 6 * 60 * 60;

function signature(secret: string, podcastId: string, episodeId: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`${podcastId}.${episodeId}.${expiresAt}`).digest("base64url");
}

/**
 * The unauthenticated URL for an episode's audio (served by app.ts), made
 * self-authenticating by an HMAC over the ids and expiry. `t` and `Range` are
 * deliberately not signed, so seeking works on the same URL.
 */
export function signedEpisodeAudioUrl(
  origin: string,
  podcastId: string,
  episodeId: string,
  secret: string,
  nowMs: number = Date.now(),
): { url: string; expiresAt: number } {
  const expiresAt = Math.floor(nowMs / 1000) + AUDIO_URL_TTL_SECONDS;
  const sig = signature(secret, podcastId, episodeId, expiresAt);
  return {
    url: `${origin}/podcasts/${podcastId}/episodes/${episodeId}/audio?exp=${expiresAt}&sig=${sig}`,
    expiresAt,
  };
}

/** True only for an unexpired URL signed with `secret` for exactly these ids. */
export function verifyAudioSignature(
  secret: string,
  podcastId: string,
  episodeId: string,
  exp: unknown,
  sig: unknown,
  nowMs: number = Date.now(),
): boolean {
  if (typeof exp !== "string" || typeof sig !== "string" || !/^\d+$/.test(exp)) return false;
  const expiresAt = Number(exp);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= nowMs) return false;
  const expected = Buffer.from(signature(secret, podcastId, episodeId, expiresAt));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
