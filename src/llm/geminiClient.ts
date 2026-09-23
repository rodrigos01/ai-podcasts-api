import type { ApiError, GoogleGenAI as GoogleGenAIClient } from "@google/genai" with { "resolution-mode": "import" };
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
// (see streamSpeech), which is plain CommonJS.
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
 * validated structured shape (the wizards, producerPrompt, condensation),
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

/**
 * A chunk where every turn shares one speaker — the common case at
 * TARGET_CHUNK_TOKENS (ttsLimits.ts), between the kickoff-monologue turn
 * and the oversized-turn sentence-level fallback (chunker.ts) — must not go
 * through the 2-voice `multiSpeakerVoiceConfig` shape below with a silent
 * second voice declared: that mismatch is a confirmed trigger for
 * hallucinated interjections, repetition loops, and voice misattribution.
 * Route it through genuine single-voice synthesis instead.
 */
export function soloSpeakerVoiceName(turns: ScriptTurn[], aliasByName: Map<string, string>): string | null {
  if (turns.length === 0) return null;
  const first = turns[0]!;
  if (!turns.every((turn) => turn.speaker === first.speaker)) return null;
  return aliasByName.get(first.speaker) ?? sanitizeSpeakerAlias(first.speaker);
}

export async function streamSpeech(
  directorPrompt: string,
  turns: ScriptTurn[],
  speakers: SpeakerVoice[],
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const aliasByName = new Map(speakers.map((s) => [s.speaker, s.voiceName]));
  const aliasedTurns = turns.map((turn) => ({
    speaker: aliasByName.get(turn.speaker) ?? sanitizeSpeakerAlias(turn.speaker),
    text: turn.text,
  }));
  const soloVoiceName = soloSpeakerVoiceName(turns, aliasByName);

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
          // onChunk is caller-provided processing (page reassembly, Ogg
          // stitching in audio.service.ts) running synchronously inside
          // this gRPC event handler — outside the `new Promise` executor's
          // own call stack, so a throw here would NOT be caught by the
          // try/catch around it and would instead surface as a raw
          // uncaught exception deep inside the transport's dispatch, well
          // past any of our own error handling. Converting it into a
          // normal rejection here is what actually makes a bad chunk
          // recoverable instead of destabilizing (or crashing) the whole
          // process — this was very likely the real mechanism behind
          // "TTS errors crash the server," not Cloud TTS's own clean
          // content-moderation error path (which already rejects cleanly
          // via the "error" event below).
          try {
            onChunk(Buffer.from(response.audioContent as Uint8Array));
          } catch (err) {
            grpcStream.destroy?.();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        grpcStream.on("error", (err: Error) => reject(err));
        grpcStream.on("end", () => resolve());

        grpcStream.write({
          streamingConfig: {
            voice: soloVoiceName
              ? { languageCode: "en-US", modelName: TTS_MODEL, name: soloVoiceName }
              : {
                  languageCode: "en-US",
                  modelName: TTS_MODEL,
                  multiSpeakerVoiceConfig: {
                    speakerVoiceConfigs: speakers.map((s) => ({
                      speakerAlias: s.voiceName,
                      speakerId: s.voiceName,
                    })),
                  },
                },
            streamingAudioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 24000 },
          },
        });
        grpcStream.write({
          input: soloVoiceName
            ? { prompt: directorPrompt, text: turns.map((t) => t.text).join("\n\n") }
            : { prompt: directorPrompt, multiSpeakerMarkup: { turns: aliasedTurns } },
        });
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
