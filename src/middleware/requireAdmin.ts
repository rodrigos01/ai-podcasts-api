import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { HttpError } from "../utils/HttpError";
import { isAdminUid } from "../utils/admin";

/**
 * Runs after requireAuth: lets the caller through only if their uid is in
 * ADMIN_UIDS, and marks the request `isAdmin` so the shared podcast
 * controllers skip the ownership check. Anyone else gets a 403 (they are
 * authenticated, just not allowed here). Every write an admin makes is logged
 * with their uid, since regenerating spends real Gemini/TTS quota.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!isAdminUid(req.userId, env.ADMIN_UIDS)) throw new HttpError(403, "Admin access required");
  req.isAdmin = true;
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    console.log(`admin action uid=${req.userId} ${req.method} ${req.originalUrl.split("?")[0]}`);
  }
  next();
}
