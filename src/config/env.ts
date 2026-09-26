import dotenv from "dotenv";
import { z } from "zod";

// quiet: true suppresses dotenv v17's random stdout "tips" (self-promo for
// dotenvx.com and a partner site) — noise we don't want in server logs.
dotenv.config({ quiet: true });

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Text generation (geminiClient.ts) runs through the Vertex AI API using
  // this project + location, authenticated the same way as Firebase Admin
  // and Cloud TTS (service-account JSON locally, ADC when deployed) — no
  // API key needed. The GCP project backing Firebase IS the Vertex AI
  // project, so this deliberately reuses FIREBASE_PROJECT_ID rather than
  // introducing a second project id.
  VERTEX_AI_LOCATION: z.string().min(1).default("global"),
  FIREBASE_PROJECT_ID: z.string().min(1, "FIREBASE_PROJECT_ID is required"),
  // TTS only (see llm/ttsClient.ts) — the new Gemini 3.8 Flash TTS
  // interactions/voices API isn't reachable via Vertex AI on this project
  // (confirmed empirically: voices.list/voices.create 404 at Vertex's
  // routing layer, every location/api_version tried). ttsClient.ts probes
  // Vertex once per process and falls back to the AI Studio Generative
  // Language API with this key when Vertex doesn't work. Left optional at
  // the env-schema level (Vertex may start working in some environment, or
  // some day on its own) — ttsClient.ts throws a clear error at first TTS
  // call if a fallback is needed but this isn't set. Text generation
  // (geminiClient.ts) is unaffected — it stays on Vertex only.
  GEMINI_API_KEY: z.string().min(1).optional(),
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
