import { z } from "zod";

export const sourceCreateSchema = z.object({
  title: z.string().min(1),
  contents: z.string().min(1),
});

// `accessToken` is the client's own Google OAuth token (obtained via
// Google Sign-In with Drive scope) — this backend only ever forwards it to
// Google on the caller's behalf for this one request, never stores it.
export const sourceGoogleDriveSchema = z.object({
  fileId: z.string().min(1),
  accessToken: z.string().min(1),
  title: z.string().min(1).optional(),
});

export const sourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  contents: z.string().min(1),
  sourceType: z.enum(["text", "pdf"]),
  originalFilename: z.string().optional(),
  createdAt: z.number(),
});

export type SourceCreateInput = z.infer<typeof sourceCreateSchema>;
export type Source = z.infer<typeof sourceSchema>;
