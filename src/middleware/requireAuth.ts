import type { NextFunction, Request, Response } from "express";
import { getAuth } from "firebase-admin/auth";
import { firebaseApp } from "../config/firebase";
import { HttpError } from "../utils/HttpError";
import { hasAdminClaim } from "../utils/admin";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      /** Set by requireAdmin: the caller may act on any user's podcasts. */
      isAdmin?: boolean;
      /** Whether the verified ID token carries the `admin` custom claim. */
      hasAdminClaim?: boolean;
    }
  }
}

const BEARER_RE = /^Bearer (.+)$/;

/**
 * Verifies a Firebase Auth ID token and attaches the caller's uid as
 * `req.userId`. Clients sign in with the Firebase Auth SDK directly (this
 * backend never sees credentials) and send the resulting ID token on every
 * request — normally via the Authorization header, but a plain HTML
 * `<audio src="...">` element cannot attach custom headers to the request
 * it issues, and specs.md explicitly requires the audio stream endpoint to
 * work with a standard `<audio>` element. So: header first, falling back
 * to a `?token=` query param — the common workaround for exactly this
 * class of problem. Prefer the header wherever a client can set one.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const headerToken = req.headers.authorization?.match(BEARER_RE)?.[1];
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  const idToken = headerToken ?? queryToken;
  if (!idToken) {
    throw new HttpError(
      401,
      "Missing Firebase ID token: send Authorization: Bearer <token>, or ?token=<token> for media URLs",
    );
  }

  try {
    const decoded = await getAuth(firebaseApp).verifyIdToken(idToken);
    req.userId = decoded.uid;
    req.hasAdminClaim = hasAdminClaim(decoded);
    next();
  } catch {
    throw new HttpError(401, "Invalid or expired ID token");
  }
}

/** Guards against a route being reachable without requireAuth having run. */
export function requireUserId(req: Request): string {
  if (!req.userId) throw new HttpError(401, "Missing Authorization: Bearer <Firebase ID token> header");
  return req.userId;
}
