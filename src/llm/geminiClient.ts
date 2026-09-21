import type { GoogleGenAI as GoogleGenAIClient } from "@google/genai" with { "resolution-mode": "import" };
import textToSpeech from "@google-cloud/text-to-speech";
import type { ZodType } from "zod";
import { z } from "zod";
import { serviceAccount } from "../config/firebase";
import { env } from "../config/env";
import type { ScriptTurn } from "../utils/scriptText";

const TEXT_MODEL = "gemini-3.8-flash";
const TTS_MODEL = "gemini-3.1-flash-tts-preview";

let clientPromise: Promise<GoogleGenAIClient> | null = null;

// @google/genai ships ESM-only type declarations shared across its
// import/require conditions, which trips up TS's Node16 module resolution
// for a static `require`. A dynamic import sidesteps that entirely. Only
// used for text generation now — TTS moved to @google-cloud/text-to-speech
// (see synthesizeChunkAudio), which is plain CommonJS.
//
// Routed through the Vertex AI API (`vertexai: true` + project/location),
// not the API-key-based Generative Language API ("AI Studio") this client
// used before 2026-09-20 — AI Studio bills through a separate, pre-paid
// path, whereas Vertex bills the same GCP project (standard metered
// billing) that Firebase Admin and Cloud TTS already use below, so this
// reuses the same credentials resolution: the loaded service-account object
// locally, Application Default Credentials (the runtime's attached service
// account) in any deployed environment. The GCP project backing Firebase IS
// the Vertex AI project (see env.ts), so no separate project id or API key
// is needed — but the service account/runtime identity does need the
// `roles/aiplatform.user` role for Vertex AI calls to succeed.
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

// Reuses the same already-loaded service-account credentials as Firebase
// Admin (no separate file read or path resolution needed) when running
// locally with FIREBASE_SERVICE_ACCOUNT_PATH set; in any deployed
// environment `serviceAccount` is undefined and passing no `credentials`
// option here makes this client fall back to Application Default
// Credentials too, same as firebase.ts does for the Admin SDK. Unlike the
// Generative Language API client above, this one is synchronous to
// construct and plain CommonJS.
const ttsClient = new textToSpeech.TextToSpeechClient(
  serviceAccount ? { credentials: serviceAccount } : undefined,
);

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

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
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
 * per-turn conversation agent (agent.ts), whose `{speech, endEpisode}` shape
 * is simple enough to encode as plain text + a trailing marker instead. If a
 * caller genuinely needs a validated structured shape (the wizards,
 * producerPrompt, condensation), keep using `generateText`.
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

export interface SpeakerVoice {
  speaker: string;
  voiceName: string;
}

/**
 * Synthesizes one chunk's complete audio for `directorPrompt` + `turns` via
 * Cloud Text-to-Speech's unary `synthesizeSpeech` call — a single request,
 * single full-audio response, no bidirectional streaming session. Returns
 * the whole chunk's Ogg Opus bytes at once; callers still process/cache each
 * transcript chunk as its own independent call (see audio.service.ts), so
 * per-chunk on-demand generation is unaffected — only the transport for a
 * single chunk's own synthesis changed, from a bidi gRPC stream to one
 * one-way request/response.
 *
 * Switched (2026-09-21) from the bidi `streamingSynthesize` call this used
 * before, to test whether quality issues reported against that path
 * (garbled/inconsistent multi-speaker audio) are specific to bidi streaming.
 * If this doesn't measurably improve quality, it's fine to revert — see git
 * history for the previous `streamingSynthesize`-based implementation.
 *
 * `audioEncoding: "OGG_OPUS"` compresses far better than raw PCM for the
 * same audio and, unlike `streamingSynthesize` (which only accepted a
 * narrow subset of encodings), the unary call supports the full advertised
 * `AudioEncoding` set — confirmed via the client's own proto definitions.
 */
// Cloud TTS's speakerAlias is far stricter than our own speaker names:
// "cannot contain whitespace or non-alphanumeric characters" (confirmed
// empirically — rejects e.g. "Ray Sterling" outright). Beyond that hard
// requirement, Gemini TTS's own multi-speaker examples consistently use
// short, single-word aliases (e.g. "Joe") — a sanitized-but-still-
// multi-word alias like "DrEmilyChen" is legal but not what the model was
// tuned on, and empirically hurts speaker attribution in longer multi-turn
// scripts. Each speaker's assigned voice ID (Puck, Kore, ...) is already
// exactly that: one simple word, and — since voice casting is prompted to
// avoid collisions within a cast (podcastWizard/episodeWizard prompts) —
// already unique per speaker in an episode. So we use the voice ID itself
// as the wire-level alias instead of deriving one from the display name.
// Callers (audio.service.ts, audiobookAudio.service.ts) keep using real
// display names throughout and never see this. `sanitizeSpeakerAlias` below
// is only a defensive fallback for a turn whose speaker isn't in the known
// cast list (shouldn't happen, but shouldn't crash generation either).
function sanitizeSpeakerAlias(name: string): string {
  const alias = name.replace(/[^A-Za-z0-9]/g, "");
  return alias || "Speaker";
}

export async function synthesizeChunkAudio(
  directorPrompt: string,
  turns: ScriptTurn[],
  speakers: SpeakerVoice[],
): Promise<Buffer> {
  const aliasByName = new Map(speakers.map((s) => [s.speaker, s.voiceName]));
  const aliasedTurns = turns.map((turn) => ({
    speaker: aliasByName.get(turn.speaker) ?? sanitizeSpeakerAlias(turn.speaker),
    text: turn.text,
  }));

  // Unlike the old bidi call, nothing is ever written to a live response
  // before this resolves — the whole chunk's audio comes back in one shot —
  // so a clean, unconditional retry-the-whole-call is safe here, same as
  // withRetry's other callers, with no "did we already emit bytes" tracking
  // needed.
  const [response] = await withRetry(() =>
    ttsClient.synthesizeSpeech({
      input: { prompt: directorPrompt, multiSpeakerMarkup: { turns: aliasedTurns } },
      voice: {
        languageCode: "en-US",
        modelName: TTS_MODEL,
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakers.map((s) => ({
            speakerAlias: s.voiceName,
            speakerId: s.voiceName,
          })),
        },
      },
      audioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 24000 },
    }),
  );

  if (!response.audioContent) {
    throw new Error("Cloud TTS returned no audio data");
  }
  return Buffer.from(response.audioContent as Uint8Array);
}

export async function countTokens(text: string): Promise<number> {
  const client = await getClient();
  const response = await withRetry(() =>
    client.models.countTokens({ model: TEXT_MODEL, contents: text }),
  );
  return response.totalTokens ?? Math.ceil(text.length / 4);
}
