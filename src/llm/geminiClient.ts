import type { ApiError, GoogleGenAI as GoogleGenAIClient } from "@google/genai" with { "resolution-mode": "import" };
import type { ZodType } from "zod";
import { z } from "zod";
import { serviceAccount } from "../config/firebase";
import { env } from "../config/env";

const TEXT_MODEL = "gemini-3.8-flash";

let clientPromise: Promise<GoogleGenAIClient> | null = null;

// @google/genai ships ESM-only type declarations shared across its
// import/require conditions, which trips up TS's Node16 module resolution
// for a static `require`. A dynamic import sidesteps that entirely.
//
// Routed through the Vertex AI API (`vertexai: true` + project/location),
// not the API-key-based Generative Language API ("AI Studio") this client
// used before 2026-09-20 — AI Studio bills through a separate, pre-paid
// path, whereas Vertex bills the same GCP project (standard metered
// billing) that Firebase Admin already uses, so this reuses the same
// credentials resolution: the loaded service-account object locally,
// Application Default Credentials (the runtime's attached service account)
// in any deployed environment. The GCP project backing Firebase IS the
// Vertex AI project (see env.ts), so no separate project id or API key is
// needed here — but the service account/runtime identity does need the
// `roles/aiplatform.user` role for Vertex AI calls to succeed.
//
// TTS is a separate concern entirely now — see llm/ttsClient.ts, which
// talks to Gemini 3.8 Flash TTS's `interactions`/`voices` API and (unlike
// text generation here) has to fall back to the AI Studio API with a plain
// API key, since that API isn't reachable via Vertex AI on this project.
function getClient(): Promise<GoogleGenAIClient> {
  if (!clientPromise) {
    clientPromise = import("@google/genai").then(
      ({ GoogleGenAI }) =>
        new GoogleGenAI({
          vertexai: true,
          project: env.FIREBASE_PROJECT_ID,
          location: env.VERTEX_AI_LOCATION,
          googleAuthOptions: serviceAccount ? { credentials: serviceAccount } : undefined,
        }),
    );
  }
  return clientPromise;
}

/**
 * Gemini's structured-output schema is an OpenAPI-3.0 subset: it rejects
 * unknown keys like `$schema`/`additionalProperties` that zod's JSON Schema
 * export includes. Strip those recursively so the same zod schema can drive
 * both the API's responseSchema and our own re-validation of its output.
 */
function toGeminiSchema(schema: ZodType): unknown {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
  return sanitize(jsonSchema);
}

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitize);
  }
  if (node && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" || key === "additionalProperties") continue;
      result[key] = sanitize(value);
    }
    return result;
  }
  return node;
}

interface GenerateTextOptions<T> {
  systemInstruction: string;
  prompt: string;
  schema: ZodType<T>;
}

// Vertex AI's per-minute quota for TEXT_MODEL trips under bursts of
// concurrent calls (confirmed empirically: 1/30 concurrent requests came
// back 429 RESOURCE_EXHAUSTED while the other 29 succeeded) — the flat
// `attempt * 500ms` backoff below isn't built for that, since it barely
// spaces out retries before quota has a chance to free up. A 429 gets a
// much longer exponential delay (2s, 4s, 8s, ...) instead; every other
// error keeps the original short linear backoff.
function isRateLimitError(err: unknown): err is ApiError {
  return err instanceof Error && "status" in err && (err as ApiError).status === 429;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const delay = isRateLimitError(err) ? 2 ** attempt * 1000 : attempt * 500;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

export async function generateText<T>(options: GenerateTextOptions<T>): Promise<T> {
  const responseSchema = toGeminiSchema(options.schema);
  const client = await getClient();

  const response = await withRetry(() =>
    client.models.generateContent({
      model: TEXT_MODEL,
      contents: options.prompt,
      config: {
        systemInstruction: options.systemInstruction,
        responseMimeType: "application/json",
        responseSchema,
      },
    }),
  );

  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 200)}`);
  }

  return options.schema.parse(parsed);
}

interface GeneratePlainTextOptions {
  systemInstruction: string;
  prompt: string;
}

/**
 * Plain, unstructured text generation — no `responseSchema`/`responseMimeType`.
 * Confirmed empirically (structured-vs-plain-tmp.ts, 15 real trials): grammar-
 * constrained structured output on this model runs ~35-55% slower on average
 * than free-form text for an equivalent short response, with a noticeably
 * fatter slow tail (multi-second outliers were structured-only). Use this
 * for call sites that don't actually need a validated JSON shape — e.g. the
 * single-LLM episode script writer (episodeGeneration/scriptGeneration.service.ts),
 * whose output is just the "Name: line" transcript text itself, parsed by
 * scriptText.ts rather than JSON-decoded. If a caller genuinely needs a
 * validated structured shape (the wizards, condensation, voiceResolution),
 * keep using `generateText`.
 */
export async function generatePlainText(options: GeneratePlainTextOptions): Promise<string> {
  const client = await getClient();

  const response = await withRetry(() =>
    client.models.generateContent({
      model: TEXT_MODEL,
      contents: options.prompt,
      config: {
        systemInstruction: options.systemInstruction,
      },
    }),
  );

  const text = response.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }
  return text;
}
