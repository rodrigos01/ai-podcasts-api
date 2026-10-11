import type { NextFunction, Request, Response } from "express";

/**
 * CORS for the public audio URL: a Chromecast receiver (and web players on
 * other origins) fetch it cross-origin, and the receiver rejects media
 * responses without these headers. Open to any origin because the URL itself
 * carries no credentials.
 */
export function castCors(req: Request, res: Response, next: NextFunction) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Range, Content-Type");
    res.set("Access-Control-Max-Age", "86400");
    res.status(204).end();
    return;
  }
  next();
}
