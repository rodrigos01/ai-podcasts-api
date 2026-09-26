import type { GoogleGenAI as GoogleGenAIClient } from "@google/genai" with { "resolution-mode": "import" };
import { serviceAccount } from "../config/firebase";
import { env } from "../config/env";
import { MAX_CHUNK_AUDIO_SECONDS, MAX_EPISODE_AUDIO_SECONDS, STREAM_INACTIVITY_TIMEOUT_MS } from "../constants/ttsLimits";
import type { ScriptTurn } from "../utils/scriptText";
import { DEFAULT_PCM_FORMAT, durationSeconds } from "../utils/wav";
import { stream } from "../controllers/audio.controller";

// The Gemini 3.8 Flash TTS "interactions"/"voices" bridge, replacing the old
// @google-cloud/text-to-speech pipeline entirely (see AGENTS.md). Confirmed
// empirically in the investigation spike: this API is NOT reachable via
// Vertex AI on this project today (voices.list/voices.create 404 at
// Vertex's own routing layer, every location/api_version tried;
// interactions.create rejects every model tried there, including one that
// works fine via geminiClient.ts's Vertex text-gen path) — only the AI
// Studio Generative Language API (a plain API key) works. getTtsClient
// below defaults to Vertex, probes it once, and falls back to AI Studio so
// this is ready the moment Vertex support lands, without a code change.
//
// @google/genai ships ESM-only type declarations that trip up TS's Node16
// module resolution for a static import — same issue geminiClient.ts's
// getClient already works around with a dynamic import + this type-only
// import guarded by "resolution-mode": "import". Don't "simplify" this back
// to a static import without re-testing `tsc --noEmit`.

export type TtsBackend = "vertex" | "aistudio";

interface TtsClientHandle {
  client: GoogleGenAIClient;
  backend: TtsBackend;
}

// Both named in the investigation's migration doc; tried in order inside
// streamEpisodeSynthesis's own retry loop, since there's no cheap way to
// probe which one is enabled for this project/account without spending a
// real synthesis call — whichever one first produces audio is cached in
// resolvedModel for every later call to use directly.
const TTS_MODEL_CANDIDATES = ["gemini-3.8-flash-tts"] as const;
let resolvedModel: string | null = null;

let clientPromise: Promise<TtsClientHandle> | null = null;

async function probeVertexVoicesApi(client: GoogleGenAIClient): Promise<boolean> {
  try {
    await client.voices.list({ page_size: 1 });
    return true;
  } catch {
    return false;
  }
}

async function loadTtsClient(): Promise<TtsClientHandle> {
  const { GoogleGenAI } = await import("@google/genai");
  const vertexClient = new GoogleGenAI({
    vertexai: true,
    project: env.FIREBASE_PROJECT_ID,
    location: env.VERTEX_AI_LOCATION,
    googleAuthOptions: serviceAccount ? { credentials: serviceAccount } : undefined,
  });
  if (await probeVertexVoicesApi(vertexClient)) {
    return { client: vertexClient, backend: "vertex" };
  }
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "Gemini 3.8 Flash TTS's interactions/voices API isn't reachable via Vertex AI on this " +
        "project, and GEMINI_API_KEY isn't set to fall back to the AI Studio Generative " +
        "Language API. Set GEMINI_API_KEY to enable TTS.",
    );
  }
  return { client: new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }), backend: "aistudio" };
}

/**
 * Resolves once per process lifetime — checked lazily on first use, not
 * per-call, since re-probing Vertex on every episode would waste latency
 * for no benefit (a redeploy re-runs the probe). Exported for callers that
 * want to log/report which backend is actually active.
 */
export function getTtsClient(): Promise<TtsClientHandle> {
  if (!clientPromise) clientPromise = loadTtsClient();
  return clientPromise;
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && "status" in err && (err as { status?: number }).status === 429;
}

// Cloud TTS's moderation-rejection shape (a gRPC INVALID_ARGUMENT naming
// Vertex AI's usage guidelines — see geminiClient.ts's
// isModerationRejectionError) has no confirmed equivalent on this API yet;
// the investigation's spike never triggered one. This is a best-effort
// keyword check on whatever error message this API does surface, so a real
// rejection at least gets the same longer backoff a 429 gets rather than a
// short one — re-verify against a real rejection once seen live.
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

async function withBackoff<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const delay =
          isRateLimitError(err) || looksLikeModerationRejection(err) ? 2 ** attempt * 1000 : attempt * 500;
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
// Voices: Voice Design (hosts, and guests who need an accent) + Voice
// Library search (other guests) — see
// services/episodeGeneration/voiceResolution.service.ts, which calls these.
// ---------------------------------------------------------------------------

export interface DesignVoiceInput {
  displayName: string;
  languageCode: string;
  gender: "male" | "female" | "neutral";
  voiceDescription: string;
}

export async function designVoice(input: DesignVoiceInput): Promise<string> {
  const { client } = await getTtsClient();
  const voice = await withBackoff(
    () =>
      client.voices.create({
        store: true,
        voice: {
          type: "prompted",
          display_name: input.displayName,
          language_code: input.languageCode,
          gender: input.gender,
          prompted: { input: input.voiceDescription },
        },
      }),
    3,
  );
  if (!voice.id) throw new Error("Voice Design did not return a voice id");
  return voice.id;
}

export interface LibraryVoiceFilters {
  languageCode: string;
  gender: "male" | "female" | "neutral";
  pitch?: "low" | "medium" | "high";
  accent?: string;
  personaKeywords: string[];
  contexts: string[];
  search?: string;
}

export interface LibraryVoiceMatch {
  voiceId: string;
  displayName?: string;
}

/**
 * Searches the Voice Library with a progressively looser fallback ladder —
 * the tightest filter combination often returns nothing (confirmed live in
 * the investigation), so this drops filters tier by tier rather than
 * failing outright. Ported from the investigation's spike script.
 */
export async function findLibraryVoice(filters: LibraryVoiceFilters): Promise<LibraryVoiceMatch> {
  const { client } = await getTtsClient();
  const attempts: Array<Record<string, unknown>> = [
    {
      language_code: [filters.languageCode],
      gender: [filters.gender],
      pitch: filters.pitch ? [filters.pitch] : undefined,
      accent: filters.accent ? [filters.accent] : undefined,
      persona: filters.personaKeywords,
      contexts: filters.contexts,
      search: filters.search,
      type: ["prebuilt"],
      page_size: 10,
    },
    {
      language_code: [filters.languageCode],
      gender: [filters.gender],
      accent: filters.accent ? [filters.accent] : undefined,
      type: ["prebuilt"],
      page_size: 10,
    },
    { language_code: [filters.languageCode], gender: [filters.gender], type: ["prebuilt"], page_size: 10 },
    { language_code: [filters.languageCode], type: ["prebuilt"], page_size: 10 },
  ];

  for (const raw of attempts) {
    const params = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
    const res = await withBackoff(() => client.voices.list(params), 3);
    const top = res.voices?.[0];
    if (top?.id) return { voiceId: top.id, displayName: top.display_name };
  }
  throw new Error(`No Voice Library match found (language ${filters.languageCode})`);
}

/**
 * Best-effort cleanup of a guest's Voice-Design voice once its episode's
 * audio generation finishes — see voiceResolution.service.ts's
 * cleanupGuestVoice. Never called for a Library voice (nothing to delete;
 * that's not ours to manage). Logs and swallows errors: a leaked
 * quota-counted voice from an occasional failed delete is a much smaller
 * problem than an episode's audio generation failing over cleanup.
 */
export async function deleteVoice(voiceId: string): Promise<void> {
  try {
    const { client } = await getTtsClient();
    await client.voices.delete(voiceId);
  } catch (err) {
    console.error(`Failed to delete temporary voice ${voiceId} (leaving it for its natural TTL):`, err);
  }
}

// ---------------------------------------------------------------------------
// Synthesis — one streaming call per episode, no chunking. See
// services/audio.service.ts for how this is wired into generation/caching.
// ---------------------------------------------------------------------------

export interface TtsVoiceAssignment {
  label: string;
  voiceId: string;
  // Only needed when resolving a voice for the first time (a Voice-Design
  // voice already has its language baked in from creation, and a Library
  // voice was already chosen for a specific language) — omit it when
  // reusing a previously-resolved voice (see voiceResolution.service.ts).
  languageCode?: string;
}

export function buildContentItems(turns: ScriptTurn[], multiSpeaker: boolean) {
  return turns.map((turn) => {
    const annotations: { type: "speech_metadata"; speaker?: string; style?: string }[] = [];
    if (multiSpeaker) {
      annotations.push({
        type: "speech_metadata" as const,
        speaker: turn.speaker,
        ...(turn.style ? { style: turn.style } : {}),
      });
    } else if (turn.style) {
      annotations.push({
        type: "speech_metadata" as const,
        style: turn.style,
      });
    }
    return {
      type: "text" as const,
      text: turn.text.replaceAll(/\[/g, "<").replaceAll(/\]/g, ">").trim(),
      annotations: annotations.length > 0 ? annotations : undefined,
    };
  });
}

/**
 * A transcript where every turn shares one speaker must not declare a
 * second, silent voice in speech_config — the same confirmed Cloud-TTS-era
 * artifact (hallucinated interjections, misattribution) this avoided there.
 * Rare at the whole-episode scale (this app's two-voice cast almost always
 * means a real back-and-forth), but cheap to guard against.
 */
export function soloSpeakerLabel(turns: ScriptTurn[]): string | null {
  if (turns.length === 0) return null;
  const first = turns[0]!;
  return turns.every((turn) => turn.speaker === first.speaker) ? first.speaker : null;
}

interface ConsumeResult {
  totalBytes: number;
  // Every event this call saw that wasn't a "step.delta"/"audio" delta, with
  // a small JSON snapshot of each distinct shape encountered (capped, since
  // a legitimate delta stream can otherwise also carry many step.start/
  // step.done/response.completed bookkeeping events we don't need to act
  // on). Populated regardless of outcome — see the module comment above
  // `streamEpisodeSynthesis` for why: this API's moderation/error event
  // shape isn't confirmed yet, and a silently-empty stream (no thrown
  // error, zero audio bytes) has otherwise been completely opaque to
  // debug — there's nothing else in this app's logs that explains *why*
  // no audio came back for a specific, reproducible episode.
  otherEvents: string[];
}

const MAX_OTHER_EVENTS_LOGGED = 10;

async function consumeInteractionStream(
  stream: AsyncIterable<unknown>,
  onDelta: (pcm: Buffer) => void,
  maxAudioSeconds: number = MAX_CHUNK_AUDIO_SECONDS,
): Promise<ConsumeResult> {
  let totalBytes = 0;
  const otherEvents: string[] = [];
  const iterator = (stream as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
  for (;;) {
    const result = await withTimeout(
      iterator.next(),
      STREAM_INACTIVITY_TIMEOUT_MS,
      `Gemini TTS stream stalled: no event for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000}s`,
    );
    if (result.done) break;
    const event = result.value;
    if (
      event?.event_type === "step.delta" &&
      (event.delta as { type?: string } | undefined)?.type === "audio"
    ) {
      const data = (event.delta as { data?: string }).data;
      if (data) {
        const pcm = Buffer.from(data, "base64");
        totalBytes += pcm.length;
        onDelta(pcm);
        if (durationSeconds(DEFAULT_PCM_FORMAT, totalBytes) > maxAudioSeconds) {
          throw new Error(
            `Audio exceeded ${maxAudioSeconds}s — aborting a likely runaway TTS response`,
          );
        }
      }
    } else if (otherEvents.length < MAX_OTHER_EVENTS_LOGGED) {
      try {
        otherEvents.push(JSON.stringify(event).slice(0, 500));
      } catch {
        otherEvents.push(String(event));
      }
    }
  }
  return { totalBytes, otherEvents };
}

/**
 * Synthesizes an entire episode's audio in one streaming call — no
 * chunking (see ttsLimits.ts's module comment for why). `onDelta` is
 * invoked once per raw PCM (audio/l16, 24kHz, mono) delta, in arrival
 * order, so callers can pipe straight to a live HTTP response while also
 * caching (see audio.service.ts).
 *
 * A stall (no event for STREAM_INACTIVITY_TIMEOUT_MS) or any error is only
 * retried from scratch while *no* audio has been emitted yet for this call
 * — once `onDelta` has been invoked, a caller may already have forwarded
 * those bytes to a live listener, and this API has no way to resume a
 * stalled stream (confirmed in the investigation), so retrying would mean
 * generating a different, non-reproducible rendition of already-delivered
 * content. Per this migration's explicitly-accepted tradeoff (see
 * AGENTS.md), that case surfaces as a failure instead — the caller
 * (audio.service.ts) discards its in-progress cache and the next request
 * starts a fresh attempt.
 */
export async function streamEpisodeSynthesis(
  turns: ScriptTurn[],
  voices: TtsVoiceAssignment[],
  onDelta: (pcm: Buffer) => void,
  maxAudioSeconds: number = MAX_CHUNK_AUDIO_SECONDS,
): Promise<void> {
  const { client } = await getTtsClient();
  const soloLabel = soloSpeakerLabel(turns);
  const activeVoices = soloLabel ? voices.filter((v) => v.label === soloLabel) : voices;
  const multiSpeaker = activeVoices.length > 1;

  let receivedAnyAudio = false;
  let lastError: unknown;
  const attempts = 3;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Once a model has been confirmed working, every later call (and every
    // later attempt within this call) goes straight to it — no more probing.
    // Until then, each attempt tries the next untried candidate so a
    // "model not available" failure on the first one doesn't burn all of
    // this call's retry budget on a model that will never work.
    const model = resolvedModel ?? TTS_MODEL_CANDIDATES[(attempt - 1) % TTS_MODEL_CANDIDATES.length]!;
    try {
      const params = {
        model,
        input: [{ type: "user_input", content: buildContentItems(turns, multiSpeaker) }],
        response_format: { type: "audio" },
        generation_config: {
          speech_config: {
            mode: "conversational",
            speakers: activeVoices.map((v) => ({
              ...(multiSpeaker ? { speaker: v.label } : {}),
              voice: v.voiceId,
              ...(v.languageCode ? { language: v.languageCode } : {}),
            })),
          }
        },
        stream: true,
      } as Parameters<typeof client.interactions.create>[0]
      const stream = await client.interactions.create(params);
      const { totalBytes, otherEvents } = await consumeInteractionStream(
        stream as unknown as AsyncIterable<unknown>,
        (pcm) => {
          receivedAnyAudio = true;
          onDelta(pcm);
        },
        maxAudioSeconds,
      );
      if (totalBytes === 0) {
        // A clean-completing stream with zero audio bytes and no thrown
        // error is otherwise a dead end to debug — this API's moderation/
        // rejection event shape isn't confirmed (see AGENTS.md), so log
        // whatever non-audio events the stream actually carried instead of
        // guessing. This is the first thing to check on a repeat of this
        // error for a specific episode.
        console.error(
          `Gemini TTS stream for model ${model} completed with zero audio bytes. Non-audio events seen (${otherEvents.length}):`,
          otherEvents,
        );
        throw new Error(
          otherEvents.length > 0
            ? `Gemini TTS stream produced no audio data (saw: ${otherEvents.join(" | ")})`
            : "Gemini TTS stream produced no audio data (stream ended with no events at all)",
        );
      }
      resolvedModel = model;
      return;
    } catch (err) {
      lastError = err;
      // A retry after any audio was already emitted would mean forwarding a
      // different, non-reproducible rendition of content a listener may
      // already have received — surface the failure instead (see this
      // function's doc comment and AGENTS.md's accepted-tradeoff note).
      if (receivedAnyAudio) break;
      if (attempt < attempts) {
        const delay = looksLikeModerationRejection(err) ? 2 ** attempt * 1000 : attempt * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Gemini TTS synthesis failed: ${errorMessage(lastError)}`);
}
