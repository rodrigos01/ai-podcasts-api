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
// (see streamSpeech), which is plain CommonJS and has a much cheaper cost
// basis for the same underlying models.
function getClient(): Promise<GoogleGenAIClient> {
  if (!clientPromise) {
    clientPromise = import("@google/genai").then(
      ({ GoogleGenAI }) => new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }),
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

export interface SpeakerVoice {
  speaker: string;
  voiceName: string;
}

/**
 * Streams raw PCM deltas for `directorPrompt` + `turns` as they're
 * synthesized, via Cloud Text-to-Speech's bidi `streamingSynthesize` gRPC
 * call — genuine incremental streaming, not a one-shot call. `onChunk` is
 * invoked once per delta with its decoded bytes, in order, so callers can
 * pipe straight to an HTTP response while also buffering for caching.
 *
 * Migrated off the Generative Language API's Interactions endpoint to this
 * client: same underlying model, same multi-speaker + free-text-prompt
 * capability (confirmed empirically — `StreamingSynthesisInput` accepts a
 * `prompt` string alongside `multiSpeakerMarkup.turns`), much cheaper
 * billing for it. `audioEncoding: "OGG_OPUS"` compresses far better than
 * raw PCM for the same audio — confirmed empirically that `streamingSynthesize`
 * only accepts a subset of the API's advertised encodings: `LINEAR16` and
 * `MP3` are both rejected outright ("Unsupported audio encoding") even
 * though they're valid for the non-streaming `synthesizeSpeech` call;
 * `PCM` and `OGG_OPUS` are the two confirmed to work. Don't "fix" this back
 * to LINEAR16 or MP3 without re-confirming against the live API first.
 */
// Cloud TTS's speakerAlias is far stricter than our own speaker names:
// "cannot contain whitespace or non-alphanumeric characters" (confirmed
// empirically — rejects e.g. "Ray Sterling" outright). Real names
// (host/guest/cast names) routinely contain spaces, apostrophes, etc., so
// we sanitize into an alphanumeric-only alias for the wire format and map
// back internally — callers (audio.service.ts, audiobookAudio.service.ts)
// keep using real display names throughout and never see this constraint.
function sanitizeSpeakerAlias(name: string): string {
  const alias = name.replace(/[^A-Za-z0-9]/g, "");
  return alias || "Speaker";
}

export async function streamSpeech(
  directorPrompt: string,
  turns: ScriptTurn[],
  speakers: SpeakerVoice[],
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const aliasByName = new Map(speakers.map((s) => [s.speaker, sanitizeSpeakerAlias(s.speaker)]));
  const aliasedTurns = turns.map((turn) => ({
    speaker: aliasByName.get(turn.speaker) ?? sanitizeSpeakerAlias(turn.speaker),
    text: turn.text,
  }));

  let receivedAnyAudio = false;
  let lastError: unknown;
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const grpcStream = ttsClient.streamingSynthesize();

        grpcStream.on("data", (response: { audioContent?: Uint8Array | Buffer | string | null }) => {
          if (!response.audioContent) return;
          receivedAnyAudio = true;
          onChunk(Buffer.from(response.audioContent as Uint8Array));
        });
        grpcStream.on("error", (err: Error) => reject(err));
        grpcStream.on("end", () => resolve());

        grpcStream.write({
          streamingConfig: {
            voice: {
              languageCode: "en-US",
              modelName: TTS_MODEL,
              multiSpeakerVoiceConfig: {
                speakerVoiceConfigs: speakers.map((s) => ({
                  speakerAlias: aliasByName.get(s.speaker),
                  speakerId: s.voiceName,
                })),
              },
            },
            streamingAudioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 24000 },
          },
        });
        grpcStream.write({ input: { prompt: directorPrompt, multiSpeakerMarkup: { turns: aliasedTurns } } });
        grpcStream.end();
      });
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      // A retry after any audio was already emitted would duplicate bytes
      // already written to a live HTTP response — only a clean failure
      // (nothing emitted yet) is safe to retry.
      if (receivedAnyAudio) break;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }

  if (lastError) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Cloud TTS stream failed: ${message}`);
  }
  if (!receivedAnyAudio) {
    throw new Error("Cloud TTS stream produced no audio data");
  }
}

export async function countTokens(text: string): Promise<number> {
  const client = await getClient();
  const response = await withRetry(() =>
    client.models.countTokens({ model: TEXT_MODEL, contents: text }),
  );
  return response.totalTokens ?? Math.ceil(text.length / 4);
}
