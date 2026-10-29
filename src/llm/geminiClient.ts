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
// Routed through the Gemini Enterprise Agent Platform API (`enterprise:
// true` + project/location — the SDK's current name for what used to be
// called "Vertex AI"; the `vertexai` flag still works but the SDK's own
// types now say `enterprise` is recommended instead, same underlying
// aiplatform.googleapis.com endpoint either way), not the API-key-based
// Generative Language API ("AI Studio") this client used before
// 2026-09-20 — AI Studio bills through a separate, pre-paid path, whereas
// this bills the same GCP project (standard metered billing) that Firebase
// Admin already uses, so this reuses the same credentials resolution: the
// loaded service-account object locally, Application Default Credentials
// (the runtime's attached service account) in any deployed environment.
// The GCP project backing Firebase IS the Gemini Enterprise project (see
// env.ts), so no separate project id or API key is needed here — but the
// service account/runtime identity does need the `roles/aiplatform.user`
// role for calls to succeed.
//
// All text generation goes through the Interactions API
// (`client.interactions.create`), which is where Google launches new
// models/features going forward; `generateContent` remains supported but
// isn't used here. Two things about it that aren't obvious:
//  - It only serves the `global` location (hence the constant below; there
//    is no location env var anymore).
//  - Interactions are stored server-side for 7 days BY DEFAULT. Calls here
//    set `store: false` (stateless / zero data retention): prompts carry
//    users' source material and the responses are full transcripts. The one
//    exception is a podcast that uses interaction context (see
//    episodeGeneration/continuity.ts): its episode drafts and scripts are
//    stored and chained with `previous_interaction_id`. Probed 2026-10-28:
//    a call that sets `previous_interaction_id` MUST also set `store: true`
//    (400 otherwise), the chain carries over even when the system
//    instruction differs between calls, structured output works on a
//    continued call, and an unknown, malformed or expired id answers
//    404 "Requested entity was not found." (`PreviousInteractionNotFoundError`).
//
// TTS is a separate concern — see llm/ttsClient.ts, which uses the same
// platform and credentials but talks to Gemini 3.8 Flash TTS's
// `generateContent` and Voices APIs (the Enterprise surface for that model).
const LOCATION = "global";

function getClient(): Promise<GoogleGenAIClient> {
  if (!clientPromise) {
    clientPromise = import("@google/genai").then(
      ({ GoogleGenAI }) =>
        new GoogleGenAI({
          enterprise: true,
          project: env.FIREBASE_PROJECT_ID,
          location: LOCATION,
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

interface InteractionChainOptions {
  /**
   * Continue the server-side conversation held by an earlier stored interaction.
   * The system instruction and generation config are NOT carried over by the
   * API, so they are still sent on every call. The call is stored (the API
   * requires it); an id the API no longer has throws PreviousInteractionNotFoundError.
   */
  previousInteractionId?: string;
  /** Keep the interaction server-side so a later call can chain from it. Implied by previousInteractionId. */
  store?: boolean;
}

interface GenerateTextOptions<T> extends InteractionChainOptions {
  systemInstruction: string;
  prompt: string;
  schema: ZodType<T>;
}

/** The interaction a call asked to continue is unknown to the API (never existed, malformed, or past its retention). */
export class PreviousInteractionNotFoundError extends Error {
  constructor(readonly previousInteractionId: string) {
    super(`Gemini does not have interaction ${previousInteractionId} (expired or unknown)`);
    this.name = "PreviousInteractionNotFoundError";
  }
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "status" in err && (err as ApiError).status === 404;
}

/** The chaining fields of an `interactions.create` request. */
function chainParams(options: InteractionChainOptions) {
  return {
    store: options.previousInteractionId ? true : (options.store ?? false),
    ...(options.previousInteractionId ? { previous_interaction_id: options.previousInteractionId } : {}),
  };
}

/** Turns the API's 404 for a chained call into the typed error callers fall back on. */
function asChainError(err: unknown, options: InteractionChainOptions): unknown {
  return options.previousInteractionId && isNotFoundError(err)
    ? new PreviousInteractionNotFoundError(options.previousInteractionId)
    : err;
}

// The platform's per-minute quota for TEXT_MODEL trips under bursts of
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
      if (isNotFoundError(err)) break; // a missing entity won't appear on retry
      if (attempt < attempts) {
        const delay = isRateLimitError(err) ? 2 ** attempt * 1000 : attempt * 500;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Reads the text out of a finished interaction. A non-"completed" status
 * (e.g. "incomplete" when the output hit its token limit) is an error, not
 * a result: for plain text especially, a truncated transcript would
 * otherwise be accepted silently as if it were whole.
 */
function readOutputText(interaction: { status?: string; output_text?: string }): string {
  if (interaction.status !== "completed") {
    throw new Error(`Gemini interaction ended with status "${interaction.status}" instead of "completed"`);
  }
  if (!interaction.output_text) {
    throw new Error("Gemini returned an empty response");
  }
  return interaction.output_text;
}

export async function generateText<T>(options: GenerateTextOptions<T>): Promise<T> {
  return (await generateTextWithId(options)).result;
}

/** `generateText`, also returning the id of the interaction (usable as `previousInteractionId` if it was stored). */
export async function generateTextWithId<T>(
  options: GenerateTextOptions<T>,
): Promise<{ result: T; interactionId: string }> {
  const responseSchema = toGeminiSchema(options.schema) as Record<string, unknown>;
  const client = await getClient();

  const interaction = await withRetry(() =>
    client.interactions.create({
      model: TEXT_MODEL,
      input: options.prompt,
      system_instruction: options.systemInstruction,
      response_format: responseSchema,
      ...chainParams(options),
    }),
  ).catch((err) => {
    throw asChainError(err, options);
  });

  const text = readOutputText(interaction);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 200)}`);
  }

  return { result: options.schema.parse(parsed), interactionId: interaction.id };
}

interface GeneratePlainTextOptions extends InteractionChainOptions {
  systemInstruction: string;
  prompt: string;
  /** Omitted = the model's default thinking level. */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
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
 * validated structured shape (the wizards, voiceResolution),
 * keep using `generateText`.
 */
export async function generatePlainText(options: GeneratePlainTextOptions): Promise<string> {
  return (await generatePlainTextWithId(options)).text;
}

/** `generatePlainText`, also returning the id of the interaction (usable as `previousInteractionId` if it was stored). */
export async function generatePlainTextWithId(
  options: GeneratePlainTextOptions,
): Promise<{ text: string; interactionId: string }> {
  const client = await getClient();

  const interaction = await withRetry(() =>
    client.interactions.create({
      model: TEXT_MODEL,
      input: options.prompt,
      system_instruction: options.systemInstruction,
      ...chainParams(options),
      ...(options.thinkingLevel ? { generation_config: { thinking_level: options.thinkingLevel } } : {}),
    }),
  ).catch((err) => {
    throw asChainError(err, options);
  });

  return { text: readOutputText(interaction), interactionId: interaction.id };
}
