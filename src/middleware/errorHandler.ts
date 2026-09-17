import type { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { HttpError } from "../utils/HttpError";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  // A streaming response (e.g. audio/stream) may fail after it's already
  // sent headers and some body bytes — there's no JSON error response to
  // send at that point, just a broken connection for the client to notice.
  // Delegating to Express's default handler (rather than calling res.json
  // ourselves) avoids a second ERR_HTTP_HEADERS_SENT crash on top of the
  // original error.
  if (res.headersSent) {
    console.error("Error after headers sent:", err);
    next(err);
    return;
  }

  if (err instanceof MulterError) {
    res.status(400).json({ error: "UploadError", message: err.message });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: "ValidationError",
      message: "Request failed validation",
      details: err.issues,
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.name,
      message: err.message,
      details: err.details,
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    error: "InternalServerError",
    message: "Something went wrong",
  });
}
