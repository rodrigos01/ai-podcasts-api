import dotenv from "dotenv";
import { z } from "zod";

// quiet: true suppresses dotenv v17's random stdout "tips" (self-promo for
// dotenvx.com and a partner site) — noise we don't want in server logs.
dotenv.config({ quiet: true });

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  FIREBASE_PROJECT_ID: z.string().min(1, "FIREBASE_PROJECT_ID is required"),
  // Local dev only — a downloaded service-account JSON key. Left unset in
  // any deployed environment (Cloud Run, Cloud Functions, GKE); firebase.ts
  // falls back to Application Default Credentials via the runtime's
  // attached service account instead. Never bake this file into a
  // container image — that's a long-lived secret shipped in every layer.
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().min(1).optional(),
  FIREBASE_STORAGE_BUCKET: z.string().min(1, "FIREBASE_STORAGE_BUCKET is required"),
  FIRESTORE_DATABASE_ID: z.string().min(1).default("podcasts"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
