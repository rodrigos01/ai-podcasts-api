import type {
  GenerateContentResponse,
  GoogleGenAI as GoogleGenAIClient,
} from "@google/genai" with { "resolution-mode": "import" };
import { serviceAccount } from "../config/firebase";
import { env } from "../config/env";
import { MAX_CHUNK_AUDIO_SECONDS, STREAM_INACTIVITY_TIMEOUT_MS } from "../constants/ttsLimits";
import type { ScriptTurn } from "../utils/scriptText";
import { DEFAULT_PCM_FORMAT, durationSeconds, type WavFormat } from "../utils/wav";

// Gemini 3.8 Flash TTS on the Gemini Enterprise Agent Platform (Google's
// current name for Vertex AI) — replaced the old @google-cloud/text-to-speech
// pipeline (see AGENTS.md). Two Voices-API/generateContent details here are
// easy to get wrong, and each cost a real debugging session to find:
//
//  - Synthesis goes through `models.generateContentStream` (parts carry
//    `speechMetadata`, voices go in `speechConfig`) — NOT `interactions.create`,
//    which is the AI Studio surface for this model. On Enterprise,
//    `interactions.create` rejects it with "400 Unsupported model interaction:
//    gemini-3.8-flash-tts".
//  - Voice Design needs the enum value `VOICE_TYPE_PROMPTED`, not the
//    AI Studio-style "prompted" (rejected with "400 Unsupported voice type."),
//    and `voice.model` must NOT be set together with `store: true`.
//
// Source of truth: docs.cloud.google.com/gemini-enterprise-agent-platform/
// models/text-to-speech/{overview,voice-design}. Requires @google/genai
// >= 2.25.0 (earlier versions don't type/serialize `speechMetadata`).
//
// @google/genai ships ESM-only type declarations that trip up TS's Node16
// module resolution for a static import — same issue geminiClient.ts's
// getClient already works around with a dynamic import + this type-only
// import guarded by "resolution-mode": "import". Don't "simplify" this back
// to a static import without re-testing `tsc --noEmit`.

const TTS_MODEL = "gemini-3.8-flash-tts";

// The Gemini 3.8 TTS models and the Voices API are only served from the
// `global` location.
const TTS_LOCATION = "global";

let clientPromise: Promise<GoogleGenAIClient> | null = null;

function getClient(): Promise<GoogleGenAIClient> {
  if (!clientPromise) {
    clientPromise = import("@google/genai").then(
      ({ GoogleGenAI }) =>
        new GoogleGenAI({
          enterprise: true,
          project: env.FIREBASE_PROJECT_ID,
          location: TTS_LOCATION,
          googleAuthOptions: serviceAccount ? { credentials: serviceAccount } : undefined,
        }),
    );
  }
  return clientPromise;
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && "status" in err && (err as { status?: number }).status === 429;
}

// No confirmed moderation-rejection shape on this API yet — a best-effort
// keyword check on whatever error message it does surface, so a real
// rejection at least gets the same longer backoff a 429 gets rather than a
// short one. Re-verify against a real rejection once seen live.
export function looksLikeModerationRejection(err: unknown): boolean {
  return err instanceof Error && /usage guidelines|safety|blocked/i.test(err.message);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    return [status, err.message].filter((v) => v !== undefined).join(" ");
  }
  return String(err);
}

async function withBackoff<T>(fn: () => Promise<T>, attempts: number, baseDelayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const delay =
          isRateLimitError(err) || looksLikeModerationRejection(err)
            ? 2 ** attempt * 1000
            : attempt * baseDelayMs;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Voices: Voice Design — see services/episodeGeneration/voiceResolution.service.ts
// ---------------------------------------------------------------------------

export interface DesignVoiceInput {
  /** The whole Voice Design prompt: an English bio plus, if any, an accent line. */
  voiceDescription: string;
}

// Voice creation generates a real audio sample, so it's slow (several
// seconds; the docs' own sample sets a 60s timeout) and, confirmed live,
// transiently fails now and then — a 503 UNAVAILABLE, or a 400 "Voice
// generation did not complete" — that succeeds on a plain retry. Hence the
// longer backoff than the 500ms steps the other calls use.
const DESIGN_VOICE_TIMEOUT_MS = 60_000;
const DESIGN_VOICE_ATTEMPTS = 4;
const DESIGN_VOICE_BACKOFF_MS = 3_000;

export async function designVoice(input: DesignVoiceInput): Promise<string> {
  const client = await getClient();
  const voice = await withBackoff(
    () =>
      client.voices.create(
        {
          store: true,
          voice: {
            type: "VOICE_TYPE_PROMPTED",
            prompted: { input: input.voiceDescription },
          },
        },
        { timeout: DESIGN_VOICE_TIMEOUT_MS },
      ),
    DESIGN_VOICE_ATTEMPTS,
    DESIGN_VOICE_BACKOFF_MS,
  );
  if (!voice.id) throw new Error("Voice Design did not return a voice id");
  return voice.id;
}

/**
 * Best-effort cleanup of a guest's Voice-Design voice once its episode's
 * audio generation finishes — see voiceResolution.service.ts's
 * cleanupGuestVoice. Logs and swallows errors: a leaked stored voice (which
 * expires on its own a year after last use) is a much smaller problem than
 * an episode's audio generation failing over cleanup.
 */
export async function deleteVoice(voiceId: string): Promise<void> {
  try {
    const client = await getClient();
    await client.voices.delete(voiceId);
  } catch (err) {
    console.error(`Failed to delete temporary voice ${voiceId} (leaving it for its natural TTL):`, err);
  }
}

/** Voice ids Voice Design hands out (`voice_` + uuid), as opposed to prebuilt catalog names. */
export function isDesignedVoiceId(id: string): boolean {
  return /^voice_[A-Za-z0-9-]{1,64}$/.test(id);
}

/** Reads rate/channels from a mime type like `audio/l16; rate=24000; channels=1`. */
export function parsePcmMimeType(mimeType: string | undefined): WavFormat {
  const rate = Number(/rate=(\d+)/i.exec(mimeType ?? "")?.[1]);
  const channels = Number(/channels=(\d+)/i.exec(mimeType ?? "")?.[1]);
  return {
    ...DEFAULT_PCM_FORMAT,
    ...(rate > 0 ? { sampleRate: rate } : {}),
    ...(channels > 0 ? { numChannels: channels } : {}),
  };
}

/**
 * The sample Voice Design generated along with a stored voice (confirmed
 * live: `voices.get` returns it as inline base64 `sample_audio`, raw 16-bit
 * PCM, ~20s). Null when the voice doesn't exist (or has no sample).
 */
export async function fetchVoiceSample(
  voiceId: string,
): Promise<{ pcm: Buffer; format: WavFormat } | null> {
  const client = await getClient();
  let voice;
  try {
    voice = await client.voices.get(voiceId);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
  const sample = voice.sample_audio;
  if (!sample?.data) return null;
  return { pcm: Buffer.from(sample.data, "base64"), format: parsePcmMimeType(sample.mime_type) };
}

// ---------------------------------------------------------------------------
// Synthesis — see services/audio.service.ts for how this is wired into
// chunked generation/caching.
// ---------------------------------------------------------------------------

export interface TtsVoiceAssignment {
  label: string;
  voiceId: string;
}

export interface SpeechPart {
  text: string;
  speechMetadata?: { speaker?: string; style?: string };
}

/**
 * Turns with no spoken text are dropped rather than sent — the API rejects
 * an empty text part outright ("400 Missing text ..."), failing the whole
 * synthesis call over a turn with nothing to speak.
 * scriptGeneration.service.ts's resolveEmptyTurnText already folds a bare
 * "Speaker:\nStyle: laughs" turn's style into an inline vocal-burst tag at
 * generation time (so it's *not* empty by the time it gets here), but this
 * is still the last stop before the actual API call — it's what catches a
 * turn with genuinely nothing at all (no text, no style either), and any
 * transcript cached/persisted before that fix existed.
 */
export function buildSpeechParts(turns: ScriptTurn[], multiSpeaker: boolean): SpeechPart[] {
  return turns
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => {
      const speechMetadata = {
        ...(multiSpeaker ? { speaker: turn.speaker } : {}),
        ...(turn.style ? { style: turn.style } : {}),
      };
      return {
        text: turn.text.replaceAll(/\[/g, "<").replaceAll(/\]/g, ">").trim(),
        ...(Object.keys(speechMetadata).length > 0 ? { speechMetadata } : {}),
      };
    });
}

/**
 * A transcript where every turn shares one speaker must not declare a
 * second, silent voice in the speech config — multi-speaker mode needs
 * exactly two speakers who actually speak. Rare at chunk scale (this app's
 * two-voice cast almost always means a real back-and-forth), but a single
 * long monologue split into continuation chunks hits it.
 */
export function soloSpeakerLabel(turns: ScriptTurn[]): string | null {
  if (turns.length === 0) return null;
  const first = turns[0]!;
  return turns.every((turn) => turn.speaker === first.speaker) ? first.speaker : null;
}

interface ConsumeResult {
  totalBytes: number;
  // Every streamed chunk that carried no audio, as a small JSON snapshot
  // (capped). Populated regardless of outcome: a silently-empty stream (no
  // thrown error, zero audio bytes) is otherwise opaque to debug, and this
  // API's moderation/block shape isn't confirmed — whatever such a chunk
  // actually contains (finishReason, promptFeedback, ...) is the evidence.
  otherEvents: string[];
}

const MAX_OTHER_EVENTS_LOGGED = 10;

async function consumeStream(
  stream: AsyncIterable<GenerateContentResponse>,
  onDelta: (pcm: Buffer) => void,
  maxAudioSeconds: number,
): Promise<ConsumeResult> {
  let totalBytes = 0;
  const otherEvents: string[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    const result = await withTimeout(
      iterator.next(),
      STREAM_INACTIVITY_TIMEOUT_MS,
      `Gemini TTS stream stalled: no event for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000}s`,
    );
    if (result.done) break;
    const chunk = result.value;
    let sawAudio = false;
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      const data = part.inlineData?.data;
      if (!data) continue;
      sawAudio = true;
      const pcm = Buffer.from(data, "base64");
      totalBytes += pcm.length;
      onDelta(pcm);
      if (durationSeconds(DEFAULT_PCM_FORMAT, totalBytes) > maxAudioSeconds) {
        throw new Error(`Audio exceeded ${maxAudioSeconds}s — aborting a likely runaway TTS response`);
      }
    }
    if (!sawAudio && otherEvents.length < MAX_OTHER_EVENTS_LOGGED) {
      try {
        otherEvents.push(JSON.stringify(chunk).slice(0, 500));
      } catch {
        otherEvents.push(String(chunk));
      }
    }
  }
  return { totalBytes, otherEvents };
}

/**
 * Synthesizes one chunk's turns in a single streaming call. `onDelta` is
 * invoked once per raw PCM (audio/l16, 24kHz, mono) delta, in arrival order,
 * so callers can pipe straight to a live HTTP response while also caching
 * (see audio.service.ts).
 *
 * A stall (no event for STREAM_INACTIVITY_TIMEOUT_MS) or any error is only
 * retried from scratch while *no* audio has been emitted yet for this call
 * — once `onDelta` has been invoked, a caller may already have forwarded
 * those bytes to a live listener, and a stalled stream can't be resumed, so
 * retrying would mean generating a different, non-reproducible rendition of
 * already-delivered content. That case surfaces as a failure instead — the
 * caller (audio.service.ts) discards its in-progress cache and the next
 * request starts a fresh attempt.
 */
export async function streamEpisodeSynthesis(
  turns: ScriptTurn[],
  voices: TtsVoiceAssignment[],
  onDelta: (pcm: Buffer) => void,
  maxAudioSeconds: number = MAX_CHUNK_AUDIO_SECONDS,
): Promise<void> {
  const client = await getClient();
  const soloLabel = soloSpeakerLabel(turns);
  const activeVoices = soloLabel ? voices.filter((v) => v.label === soloLabel) : voices;
  if (activeVoices.length === 0) {
    throw new Error(`No voice assignment matches the speaker(s) in this chunk (solo label: ${soloLabel})`);
  }
  const multiSpeaker = activeVoices.length > 1;

  const speechConfig = multiSpeaker
    ? {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: activeVoices.map((v) => ({
            speaker: v.label,
            voiceConfig: { voice: v.voiceId },
          })),
        },
      }
    : { voiceConfig: { voice: activeVoices[0]!.voiceId } };

  const request = {
    model: TTS_MODEL,
    contents: [{ role: "user", parts: buildSpeechParts(turns, multiSpeaker) }],
    config: { responseModalities: ["AUDIO"], speechConfig },
  };

  let receivedAnyAudio = false;
  let lastError: unknown;
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const stream = await client.models.generateContentStream(request);
      const { totalBytes, otherEvents } = await consumeStream(
        stream,
        (pcm) => {
          receivedAnyAudio = true;
          onDelta(pcm);
        },
        maxAudioSeconds,
      );
      if (totalBytes === 0) {
        console.error(
          `Gemini TTS stream for model ${TTS_MODEL} completed with zero audio bytes. Non-audio chunks seen (${otherEvents.length}):`,
          otherEvents,
        );
        throw new Error(
          otherEvents.length > 0
            ? `Gemini TTS stream produced no audio data (saw: ${otherEvents.join(" | ")})`
            : "Gemini TTS stream produced no audio data (stream ended with no events at all)",
        );
      }
      return;
    } catch (err) {
      lastError = err;
      // A retry after any audio was already emitted would mean forwarding a
      // different, non-reproducible rendition of content a listener may
      // already have received — surface the failure instead (see this
      // function's doc comment).
      if (receivedAnyAudio) break;
      if (attempt < attempts) {
        const delay = looksLikeModerationRejection(err) ? 2 ** attempt * 1000 : attempt * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Gemini TTS synthesis failed: ${errorMessage(lastError)}`);
}
