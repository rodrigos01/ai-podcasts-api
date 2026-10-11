import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How long a signed audio URL stays valid. Long enough for a full episode plus
 * pauses and a cast receiver re-requesting on seek; clients fetch a fresh one
 * from GET .../audio/url when it lapses.
 */
export const AUDIO_URL_TTL_SECONDS = 6 * 60 * 60;

// Token layout (52 bytes -> 70 base64url chars): podcast UUID (16) | episode
// UUID (16) | expiry as unix seconds, uint32 BE (4) | MAC (16). The MAC is
// HMAC-SHA256 over the first 36 bytes, truncated to 128 bits. Everything the
// server needs is in the token, so nothing is stored; the ids are readable by
// anyone holding it (they're authorization, not secrets), but can't be changed.
const PAYLOAD_BYTES = 36;
const MAC_BYTES = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{70}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidBytes(id: string): Buffer {
  if (!UUID_RE.test(id)) throw new Error(`Cannot sign audio URL for non-UUID id: ${id}`);
  return Buffer.from(id.replaceAll("-", ""), "hex");
}

function bytesUuid(bytes: Buffer): string {
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function mac(secret: string, payload: Buffer): Buffer {
  return createHmac("sha256", secret).update(payload).digest().subarray(0, MAC_BYTES);
}

/**
 * The unauthenticated, self-authenticating URL for an episode's audio
 * (`GET /stream/:token`, served by app.ts). `t` and `Range` are not part of
 * the token, so seeking works on the same URL.
 */
export function signedEpisodeAudioUrl(
  origin: string,
  podcastId: string,
  episodeId: string,
  secret: string,
  nowMs: number = Date.now(),
): { url: string; expiresAt: number } {
  const expiresAt = Math.floor(nowMs / 1000) + AUDIO_URL_TTL_SECONDS;
  const expiry = Buffer.alloc(4);
  expiry.writeUInt32BE(expiresAt);
  const payload = Buffer.concat([uuidBytes(podcastId), uuidBytes(episodeId), expiry]);
  const token = Buffer.concat([payload, mac(secret, payload)]).toString("base64url");
  return { url: `${origin}/stream/${token}`, expiresAt };
}

/** The ids a token was issued for, or null if it's malformed, forged or expired. */
export function verifyAudioToken(
  secret: string,
  token: unknown,
  nowMs: number = Date.now(),
): { podcastId: string; episodeId: string } | null {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== PAYLOAD_BYTES + MAC_BYTES) return null;
  const payload = bytes.subarray(0, PAYLOAD_BYTES);
  if (!timingSafeEqual(bytes.subarray(PAYLOAD_BYTES), mac(secret, payload))) return null;
  if (payload.readUInt32BE(32) * 1000 <= nowMs) return null;
  return { podcastId: bytesUuid(payload.subarray(0, 16)), episodeId: bytesUuid(payload.subarray(16, 32)) };
}
