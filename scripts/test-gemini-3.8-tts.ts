/**
 * Exploratory test script for Gemini 3.8 Flash TTS — NOT wired into
 * production code. Synthesizes a real, already-generated episode's
 * transcript through the new Vertex AI `interactions`/`voices` API
 * (`@google/genai`'s "NextGen" bridge, same client class the codebase
 * already uses for text generation — see src/llm/geminiClient.ts) to see
 * whether/how it could replace the current @google-cloud/text-to-speech
 * pipeline documented in AGENTS.md. Nothing here touches src/.
 *
 * What this tests, per the new model's headline changes:
 *   - Vertex AI only, via the same GoogleGenAI client already used for text
 *     generation (no @google-cloud/text-to-speech).
 *   - Structured turn-by-turn requests (one `speech_metadata`-annotated
 *     content item per turn) instead of a flat "Name: line" transcript.
 *   - Hosts get a bespoke Voice Design (`voices.create`, type "prompted")
 *     voice; guests get a voice picked from the Extended Voice Library
 *     (`voices.list`) using filters an LLM derives from their persona.
 *   - Each speaker's language is set on the TTS request from whatever
 *     language their persona text is itself written in — detected by the
 *     same LLM call that does the voice-design/voice-search work, not a
 *     separate step.
 *   - Turn-level `style` metadata is deliberately left unset — out of scope
 *     for this test.
 *   - Whether chunking (splitting a transcript across multiple TTS calls)
 *     is still necessary, found empirically via a binary search over how
 *     large a single non-streaming call's input can be before it fails or
 *     silently truncates, starting from the full transcript.
 *
 * A real, load-bearing constraint from the model's own docs shapes this
 * script's synthesis strategy: multi-speaker synthesis in a single call
 * only supports prebuilt voices — combining a Voice-Design (`voice_...`)
 * voice into a multi-speaker request isn't supported; each speaker's turns
 * have to be synthesized individually and the audio concatenated. Since
 * hosts always get a Voice-Design voice here, this script empirically
 * checks that constraint (rather than assuming the doc is accurate) and
 * picks its synthesis strategy from the result, run by run.
 *
 * Usage:
 *   npx tsx scripts/test-gemini-3.8-tts.ts \
 *     [--podcast=ID --episode=ID] [--turns=N] [--all] [--location=LOC]
 *
 * With no --podcast/--episode, auto-picks the most recently updated
 * episode with a transcript. --turns caps the demo clip synthesized at the
 * end (default 16 turns); --all synthesizes the whole episode instead.
 *
 * Costs real, billed Vertex AI usage (text generation, voice design, TTS).
 * The binary-search probe alone is O(log N) calls; the demo clip is
 * bounded by --turns unless --all is passed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { GoogleGenAI as GoogleGenAIClient } from "@google/genai" with { "resolution-mode": "import" };

import type { Podcast } from "../src/schemas/podcast.schema";
import type { Episode } from "../src/schemas/episode.schema";
import type { Person } from "../src/schemas/person.schema";
import type { Speaker } from "../src/services/episodeGeneration/speakerSelection";
import { parseScriptTurns, type ScriptTurn } from "../src/utils/scriptText";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "ai-audio-book";
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "podcasts";
const TEXT_MODEL = "gemini-3.8-flash";
// Both named in the migration doc; tried in order, first one that actually
// works against this project/location wins (see pickWorkingModel).
const TTS_MODEL_CANDIDATES = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const DEFAULT_DEMO_TURNS = 16;
// Podcast speech runs faster than average narration; kept conservative on
// purpose so the truncation check below only fires on genuine, large gaps
// (a chunk cut off early), not normal pacing variance.
const WORDS_PER_MINUTE = 150;
const TRUNCATION_RATIO_THRESHOLD = 0.5;

const OUT_DIR = path.join(
  process.env.CLAUDE_SCRATCHPAD_DIR ??
    "/tmp/claude-0/-home-user-ai-podcasts-api/8cc666aa-6290-5920-a38b-d9923498bddf/scratchpad",
  "gemini-3.8-tts-test",
);

interface Args {
  podcast?: string;
  episode?: string;
  turns?: number;
  all?: boolean;
  location?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const arg of argv) {
    const stripped = arg.replace(/^--/, "");
    const eq = stripped.indexOf("=");
    const key = eq === -1 ? stripped : stripped.slice(0, eq);
    const value = eq === -1 ? "" : stripped.slice(eq + 1);
    if (key === "podcast") out.podcast = value;
    else if (key === "episode") out.episode = value;
    else if (key === "turns") out.turns = Number(value);
    else if (key === "all") out.all = true;
    else if (key === "location") out.location = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Firestore: find a real, already-generated episode to synthesize
// ---------------------------------------------------------------------------

function initFirestore(): Firestore {
  const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  return getFirestore(app, DATABASE_ID);
}

async function findTestEpisode(
  firestore: Firestore,
  podcastId?: string,
  episodeId?: string,
): Promise<{ podcast: Podcast; episode: Episode }> {
  if (podcastId && episodeId) {
    const episodeSnap = await firestore
      .collection("podcasts")
      .doc(podcastId)
      .collection("episodes")
      .doc(episodeId)
      .get();
    if (!episodeSnap.exists) throw new Error(`Episode ${episodeId} not found under podcast ${podcastId}`);
    const podcastSnap = await firestore.collection("podcasts").doc(podcastId).get();
    if (!podcastSnap.exists) throw new Error(`Podcast ${podcastId} not found`);
    return { podcast: podcastSnap.data() as Podcast, episode: episodeSnap.data() as Episode };
  }

  // No orderBy/where here on purpose: a collectionGroup query with a filter
  // or sort needs a composite index that may not exist in this project (see
  // AGENTS.md's own note on avoiding that operational dependency). A plain
  // fetch + in-memory filter/sort is slower but always works.
  const snap = await firestore.collectionGroup("episodes").limit(300).get();
  const candidates = snap.docs
    .map((doc) => doc.data() as Episode)
    .filter((e) => e.transcript && (e.status === "ready" || e.status === "streamable"))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const episode = candidates[0];
  if (!episode) {
    throw new Error(
      "No episode with a transcript found (status 'ready' or 'streamable'). Pass --podcast=ID --episode=ID explicitly.",
    );
  }
  const episodeDoc = snap.docs.find((doc) => (doc.data() as Episode).id === episode.id)!;
  const podcastSnap = await episodeDoc.ref.parent.parent!.get();
  if (!podcastSnap.exists) throw new Error(`Parent podcast for episode ${episode.id} not found`);
  return { podcast: podcastSnap.data() as Podcast, episode };
}

function resolveCast(podcast: Podcast, episode: Episode): [Speaker, Speaker] {
  const hosts: Speaker[] = podcast.hosts
    .filter((h) => episode.participantHostIds.includes(h.id))
    .map((h) => ({ ...h, isHost: true }));
  const guests: Speaker[] = episode.guests.map((g) => ({ ...g, isHost: false }));
  const cast = [...hosts, ...guests];
  if (cast.length !== 2) {
    throw new Error(
      `Expected exactly 2 cast members, got ${cast.length} (hosts=${hosts.length}, guests=${guests.length})`,
    );
  }
  return cast as [Speaker, Speaker];
}

// ---------------------------------------------------------------------------
// Gemini client + structured generation (self-contained — deliberately not
// reusing src/llm/geminiClient.ts, which is wired to the old Cloud TTS path
// and TTS_MODEL constant this script is testing a replacement for)
// ---------------------------------------------------------------------------

async function loadClient(location: string): Promise<GoogleGenAIClient> {
  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI({ vertexai: true, project: PROJECT_ID, location });
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && "status" in err && (err as { status?: number }).status === 429;
}

// The SDK's own errors carry a JSON `body` string plus a huge headers/stack
// dump that's useless noise on the console — pull out just the API's own
// error message (falling back to err.message for anything else).
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    const body = (err as { body?: string }).body;
    if (body) {
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } };
        if (parsed?.error?.message) return [status, parsed.error.message].filter(Boolean).join(" ");
      } catch {
        // not JSON — fall through to err.message
      }
    }
    return [status, err.message].filter(Boolean).join(" ");
  }
  return String(err);
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

// Same OpenAPI-3.0-subset stripping geminiClient.ts's toGeminiSchema does —
// Gemini's structured-output schema rejects zod's `$schema`/`additionalProperties`.
function toGeminiSchema(schema: z.ZodType): unknown {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
  return sanitize(jsonSchema);
}
function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
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

async function generateStructured<T>(
  client: GoogleGenAIClient,
  systemInstruction: string,
  prompt: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const responseSchema = toGeminiSchema(schema);
  const response = await withRetry(() =>
    client.models.generateContent({
      model: TEXT_MODEL,
      contents: prompt,
      config: { systemInstruction, responseMimeType: "application/json", responseSchema },
    }),
  );
  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");
  return schema.parse(JSON.parse(text));
}

function buildPersonaPrompt(speaker: Person): string {
  const lines = [`Persona:\n${speaker.persona}`];
  if (speaker.accent) lines.push(`Stated accent: ${speaker.accent}`);
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Voice resolution: Voice Design for hosts, Voice Library search for guests.
// Both prompts fold language detection into the same call — "language" isn't
// a separate step, it's one more field the LLM reports.
// ---------------------------------------------------------------------------

const hostVoiceSchema = z.object({
  languageCode: z.string().min(2).max(10),
  languageName: z.string().min(1),
  gender: z.enum(["male", "female", "neutral"]),
  voiceDescription: z.string().min(30),
  displayName: z.string().min(1).max(60),
});
type HostVoiceRequest = z.infer<typeof hostVoiceSchema>;

const HOST_SYSTEM_INSTRUCTION =
  "You are casting a bespoke synthetic voice for a podcast host using a text-to-speech " +
  "'voice design' system that builds a brand-new voice purely from a natural-language " +
  "description of how it sounds (age, timbre, pacing, energy, gender presentation). That " +
  "system never reads the description aloud, so it must describe only the VOICE, never the " +
  "host's biography, opinions, or topics.\n\n" +
  "First, work out what natural language the persona text below is itself written in — that " +
  "is the language this host will actually speak on the show — and report it as a BCP-47 tag " +
  "(e.g. 'en-US', 'es-ES', 'pt-BR', 'fr-FR', 'ja-JP'), preferring a specific regional tag the " +
  "text's diction suggests, otherwise a common default for that language.\n\n" +
  "Then write a vivid, 2-4 sentence voice-design description, plus a perceived gender " +
  "presentation and a short display name for this voice.";

const guestVoiceSchema = z.object({
  languageCode: z.string().min(2).max(10),
  languageName: z.string().min(1),
  gender: z.enum(["male", "female", "neutral"]),
  pitch: z.enum(["low", "medium", "high"]).optional(),
  accent: z.string().min(1).optional(),
  personaKeywords: z.array(z.string().min(1)).min(1).max(3),
  contexts: z.array(z.string().min(1)).min(1).max(2),
  search: z.string().min(1).optional(),
});
type GuestVoiceRequest = z.infer<typeof guestVoiceSchema>;

const GUEST_SYSTEM_INSTRUCTION =
  "You are selecting a stock voice for a podcast guest from a text-to-speech voice library, " +
  "by proposing filters for a ListVoices-style query: perceived gender, pitch, one to three " +
  "persona/archetype keywords (e.g. 'Warm, Friendly' or 'Narrator'), one or two usage-context " +
  "keywords (e.g. 'Conversational', 'News'), an optional accent descriptor, and an optional " +
  "free-text search string.\n\n" +
  "First, work out what natural language the persona text below is itself written in — that " +
  "is the language this guest will actually speak — and report it as a BCP-47 tag (e.g. " +
  "'en-US', 'es-ES', 'pt-BR', 'fr-FR', 'ja-JP').\n\n" +
  "Then propose filter values most likely to surface a fitting available voice for this guest.";

interface VoiceAssignment {
  label: string;
  voiceId: string;
  languageCode: string;
}

async function designHostVoice(
  client: GoogleGenAIClient,
  req: HostVoiceRequest,
): Promise<{ voiceId: string; sampleAudio?: { data?: string; mime_type?: string } }> {
  const voice = await withRetry(() =>
    client.voices.create({
      store: true,
      voice: {
        type: "prompted",
        display_name: req.displayName,
        language_code: req.languageCode,
        gender: req.gender,
        prompted: { input: req.voiceDescription },
      },
    }),
  );
  if (!voice.id) throw new Error("Voice design did not return a voice id");
  return { voiceId: voice.id, sampleAudio: voice.sample_audio };
}

interface GuestVoiceMatch {
  voiceId: string;
  displayName?: string;
  description?: string;
}

async function findGuestVoice(client: GoogleGenAIClient, req: GuestVoiceRequest): Promise<GuestVoiceMatch> {
  // Falls back to progressively looser filters if the ideal combination
  // returns nothing — logged so it's clear which attempt actually matched.
  const attempts: Array<Record<string, unknown>> = [
    {
      language_code: [req.languageCode],
      gender: [req.gender],
      pitch: req.pitch ? [req.pitch] : undefined,
      persona: req.personaKeywords,
      contexts: req.contexts,
      search: req.search,
      type: ["prebuilt"],
      page_size: 10,
    },
    { language_code: [req.languageCode], gender: [req.gender], type: ["prebuilt"], page_size: 10 },
    { language_code: [req.languageCode], type: ["prebuilt"], page_size: 10 },
  ];

  for (const [i, raw] of attempts.entries()) {
    const params = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
    const res = await withRetry(() => client.voices.list(params));
    const top = res.voices?.[0];
    if (top?.id) {
      console.log(`  [guest voice] matched on attempt ${i + 1}/${attempts.length}`, params);
      return { voiceId: top.id, displayName: top.display_name, description: top.description };
    }
  }
  throw new Error(`No voice library match found for guest (language ${req.languageCode})`);
}

// ---------------------------------------------------------------------------
// TTS synthesis
// ---------------------------------------------------------------------------

function buildContentItems(turns: ScriptTurn[], multiSpeaker: boolean) {
  return turns.map((turn) => ({
    type: "text" as const,
    text: turn.text,
    annotations: multiSpeaker ? [{ type: "speech_metadata" as const, speaker: turn.speaker }] : undefined,
  }));
}

interface SynthesisResult {
  buffer: Buffer;
  mimeType: string;
}

async function synthesize(
  client: GoogleGenAIClient,
  model: string,
  turns: ScriptTurn[],
  voices: VoiceAssignment[],
): Promise<SynthesisResult> {
  const multiSpeaker = voices.length > 1;
  const interaction = await withRetry(() =>
    client.interactions.create({
      model,
      input: [{ type: "user_input", content: buildContentItems(turns, multiSpeaker) }],
      response_format: { type: "audio" },
      generation_config: {
        speech_config: voices.map((v) => ({
          ...(multiSpeaker ? { speaker: v.label } : {}),
          voice: v.voiceId,
          language: v.languageCode,
        })),
      },
    }),
  );
  const audio = interaction.output_audio;
  if (!audio?.data) throw new Error("Response had no output_audio");
  return { buffer: Buffer.from(audio.data, "base64"), mimeType: audio.mime_type ?? "audio/wav" };
}

async function pickWorkingModel(client: GoogleGenAIClient, sampleTurn: ScriptTurn, voice: VoiceAssignment) {
  const errors: string[] = [];
  for (const model of TTS_MODEL_CANDIDATES) {
    try {
      await synthesize(client, model, [sampleTurn], [voice]);
      console.log(`[model] using ${model}`);
      return model;
    } catch (err) {
      const msg = errorMessage(err);
      console.warn(`[model] ${model} failed: ${msg}`);
      errors.push(`${model}: ${msg}`);
    }
  }
  throw new Error(`No candidate TTS model worked against project=${PROJECT_ID}:\n${errors.join("\n")}`);
}

// ---------------------------------------------------------------------------
// WAV utilities — unary Gemini 3.8 TTS calls return a complete WAV (RIFF)
// file by default, so we parse/rebuild plain WAV rather than the Ogg Opus
// machinery the current pipeline needs for Cloud TTS's streaming encoding.
// ---------------------------------------------------------------------------

interface WavFormat {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function extractPcm(buffer: Buffer): { fmt: WavFormat; pcm: Buffer } {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE buffer");
  }
  let offset = 12;
  let fmt: WavFormat | null = null;
  let pcm: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      fmt = {
        numChannels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (chunkId === "data") {
      pcm = buffer.subarray(body, body + chunkSize);
    }
    offset = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (!fmt) throw new Error("No fmt chunk found in WAV");
  if (!pcm) throw new Error("No data chunk found in WAV");
  return { fmt, pcm };
}

function durationSeconds(fmt: WavFormat, pcmLength: number): number {
  const bytesPerSecond = fmt.sampleRate * fmt.numChannels * (fmt.bitsPerSample / 8);
  return bytesPerSecond > 0 ? pcmLength / bytesPerSecond : 0;
}

function buildWav(fmt: WavFormat, pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = fmt.sampleRate * fmt.numChannels * (fmt.bitsPerSample / 8);
  const blockAlign = fmt.numChannels * (fmt.bitsPerSample / 8);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(fmt.numChannels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function concatWavBuffers(buffers: Buffer[]): Buffer {
  const parts = buffers.map(extractPcm);
  const fmt = parts[0]!.fmt;
  for (const part of parts) {
    if (
      part.fmt.sampleRate !== fmt.sampleRate ||
      part.fmt.numChannels !== fmt.numChannels ||
      part.fmt.bitsPerSample !== fmt.bitsPerSample
    ) {
      console.warn("  [concat] format mismatch between chunks — result may sound wrong", part.fmt, fmt);
    }
  }
  return buildWav(fmt, Buffer.concat(parts.map((p) => p.pcm)));
}

// ---------------------------------------------------------------------------
// Chunking-necessity probe: binary search over the largest transcript
// prefix a single non-streaming call can handle, starting from the full
// transcript. "Success" also requires the returned audio's real duration to
// roughly match the input's expected reading time — a call can return 200
// without actually saying everything it was asked to.
// ---------------------------------------------------------------------------

function wordCount(turns: ScriptTurn[]): number {
  return turns.reduce((sum, t) => sum + t.text.trim().split(/\s+/).filter(Boolean).length, 0);
}
function expectedSeconds(turns: ScriptTurn[]): number {
  return (wordCount(turns) / WORDS_PER_MINUTE) * 60;
}

interface ProbeAttempt {
  turnCount: number;
  words: number;
  ok: boolean;
  actualSeconds?: number;
  expectedSeconds: number;
  ratio?: number;
  error?: string;
}

async function probeAttempt(
  client: GoogleGenAIClient,
  model: string,
  turns: ScriptTurn[],
  voice: VoiceAssignment,
): Promise<ProbeAttempt> {
  const words = wordCount(turns);
  const expected = expectedSeconds(turns);
  try {
    const { buffer } = await synthesize(client, model, turns, [voice]);
    const { fmt, pcm } = extractPcm(buffer);
    const actual = durationSeconds(fmt, pcm.length);
    const ratio = expected > 0 ? actual / expected : 1;
    const ok = ratio >= TRUNCATION_RATIO_THRESHOLD;
    return {
      turnCount: turns.length,
      words,
      ok,
      actualSeconds: actual,
      expectedSeconds: expected,
      ratio,
      error: ok
        ? undefined
        : `possible truncation: got ${actual.toFixed(1)}s, expected ~${expected.toFixed(1)}s (ratio ${ratio.toFixed(2)})`,
    };
  } catch (err) {
    return {
      turnCount: turns.length,
      words,
      ok: false,
      expectedSeconds: expected,
      error: errorMessage(err),
    };
  }
}

function logAttempt(attempt: ProbeAttempt) {
  const status = attempt.ok ? "OK  " : "FAIL";
  const detail = attempt.ok
    ? `${attempt.actualSeconds?.toFixed(1)}s (expected ~${attempt.expectedSeconds.toFixed(1)}s, ratio ${attempt.ratio?.toFixed(2)})`
    : attempt.error;
  console.log(`  [probe] ${status} ${attempt.turnCount} turns, ${attempt.words} words — ${detail}`);
}

async function findMaxWorkingPrefix(
  client: GoogleGenAIClient,
  model: string,
  turns: ScriptTurn[],
  voice: VoiceAssignment,
): Promise<{ maxTurns: number; attempts: ProbeAttempt[]; chunkingNecessary: boolean }> {
  const attempts: ProbeAttempt[] = [];

  const full = await probeAttempt(client, model, turns, voice);
  attempts.push(full);
  logAttempt(full);
  if (full.ok) return { maxTurns: turns.length, attempts, chunkingNecessary: false };

  // Binary search for the largest prefix length that still succeeds,
  // assuming (as the old pipeline's own chunker did) that failure becomes
  // more likely, not less, as input grows.
  let lo = 1;
  let hi = turns.length - 1;
  let bestOk = 0;
  while (lo <= hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const res = await probeAttempt(client, model, turns.slice(0, mid), voice);
    attempts.push(res);
    logAttempt(res);
    if (res.ok) {
      bestOk = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { maxTurns: bestOk, attempts, chunkingNecessary: true };
}

// ---------------------------------------------------------------------------
// Multi-speaker + custom-voice feasibility check (docs say this isn't
// supported — confirmed empirically here rather than assumed)
// ---------------------------------------------------------------------------

async function probeMixedVoiceMultiSpeaker(
  client: GoogleGenAIClient,
  model: string,
  turns: ScriptTurn[],
  voices: VoiceAssignment[],
): Promise<{ ok: boolean; buffer?: Buffer; error?: string }> {
  const sample = turns.slice(0, Math.min(6, turns.length));
  try {
    const { buffer } = await synthesize(client, model, sample, voices);
    return { ok: true, buffer };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Demo synthesis — combined single call if the mixed-voice probe proved
// that works, otherwise one call per contiguous same-speaker run
// (guaranteed safe: never mixes voices within one call) with the resulting
// WAVs concatenated back into one continuous file.
// ---------------------------------------------------------------------------

async function synthesizeDemo(
  client: GoogleGenAIClient,
  model: string,
  turns: ScriptTurn[],
  voiceByLabel: Map<string, VoiceAssignment>,
  canCombine: boolean,
): Promise<{ buffers: Buffer[]; calls: number }> {
  if (canCombine) {
    const { buffer } = await synthesize(client, model, turns, [...voiceByLabel.values()]);
    return { buffers: [buffer], calls: 1 };
  }

  const runs: ScriptTurn[][] = [];
  for (const turn of turns) {
    const last = runs[runs.length - 1];
    if (last && last[0]!.speaker === turn.speaker) last.push(turn);
    else runs.push([turn]);
  }

  const buffers: Buffer[] = [];
  for (const [i, run] of runs.entries()) {
    const label = run[0]!.speaker;
    const voice = voiceByLabel.get(label);
    if (!voice) throw new Error(`No voice assigned for speaker label "${label}"`);
    console.log(`  [demo] run ${i + 1}/${runs.length}: ${label}, ${run.length} turn(s)`);
    const { buffer } = await synthesize(client, model, run, [voice]);
    buffers.push(buffer);
  }
  return { buffers, calls: runs.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const location = args.location || process.env.VERTEX_AI_LOCATION || "global";

  await mkdir(OUT_DIR, { recursive: true });
  console.log(`Output dir: ${OUT_DIR}`);
  console.log(`Project: ${PROJECT_ID}  Location: ${location}  Database: ${DATABASE_ID}`);

  const firestore = initFirestore();
  const { podcast, episode } = await findTestEpisode(firestore, args.podcast, args.episode);
  console.log(`\nPodcast: "${podcast.title}" (${podcast.id})`);
  console.log(`Episode: "${episode.title}" (${episode.id})`);

  const [a, b] = resolveCast(podcast, episode);
  const allTurns = parseScriptTurns(episode.transcript!);

  // Match whatever labels the transcript actually uses to the 2 cast
  // members, rather than assuming today's "first name only" convention
  // (speakerLabel() in speakerSelection.ts) — an older episode's transcript
  // may predate that migration and still use full names. A label matches a
  // cast member if it's their full name or their first name.
  const actualLabels = [...new Set(allTurns.map((t) => t.speaker))];
  const matchCastMember = (label: string) =>
    [a, b].find((s) => s.name === label || s.name.trim().split(/\s+/)[0] === label);
  const labelA = actualLabels.find((label) => matchCastMember(label) === a);
  const labelB = actualLabels.find((label) => matchCastMember(label) === b);
  if (!labelA || !labelB) {
    throw new Error(
      `Could not match transcript speaker labels (${actualLabels.join(", ")}) to cast members (${a.name}, ${b.name})`,
    );
  }
  console.log(`Cast: ${labelA} (${a.isHost ? "host" : "guest"}), ${labelB} (${b.isHost ? "host" : "guest"})`);

  const knownLabels = new Set([labelA, labelB]);
  const turns = allTurns.filter((t) => knownLabels.has(t.speaker));
  if (turns.length !== allTurns.length) {
    console.warn(`Dropped ${allTurns.length - turns.length} turn(s) with unrecognized speaker labels`);
  }
  console.log(`Transcript: ${turns.length} turns, ${wordCount(turns)} words\n`);

  const client = await loadClient(location);

  console.log("=== Voice resolution ===");
  const speakerVoices = new Map<string, VoiceAssignment>();
  for (const [speaker, label] of [
    [a, labelA],
    [b, labelB],
  ] as const) {
    if (speaker.isHost) {
      console.log(`[voice] ${label} (host): designing a bespoke voice...`);
      const req = await generateStructured(client, HOST_SYSTEM_INSTRUCTION, buildPersonaPrompt(speaker), hostVoiceSchema);
      console.log(`  language=${req.languageCode} (${req.languageName}) gender=${req.gender}`);
      const { voiceId, sampleAudio } = await designHostVoice(client, req);
      console.log(`  -> ${voiceId}`);
      if (sampleAudio?.data) {
        const previewPath = path.join(OUT_DIR, `voice-preview-${label}.wav`);
        await writeFile(previewPath, Buffer.from(sampleAudio.data, "base64"));
        console.log(`  preview saved: ${previewPath}`);
      }
      speakerVoices.set(label, { label, voiceId, languageCode: req.languageCode });
    } else {
      console.log(`[voice] ${label} (guest): searching the voice library...`);
      const req = await generateStructured(client, GUEST_SYSTEM_INSTRUCTION, buildPersonaPrompt(speaker), guestVoiceSchema);
      console.log(`  language=${req.languageCode} (${req.languageName}) gender=${req.gender}`);
      const match = await findGuestVoice(client, req);
      console.log(`  -> ${match.voiceId} (${match.displayName ?? "?"})`);
      speakerVoices.set(label, { label, voiceId: match.voiceId, languageCode: req.languageCode });
    }
  }

  const firstVoice = speakerVoices.get(labelA)!;
  const firstTurn = turns[0];
  if (!firstTurn) throw new Error("Transcript has no usable turns");
  const model = await pickWorkingModel(client, firstTurn, firstVoice);

  console.log("\n=== Multi-speaker + custom-voice feasibility ===");
  console.log("(docs say a single multi-speaker call can't mix a Voice-Design voice in — checking that live)");
  const mixed = await probeMixedVoiceMultiSpeaker(client, model, turns, [...speakerVoices.values()]);
  if (mixed.ok) {
    console.log("Combined multi-speaker call with a designed voice SUCCEEDED (contrary to the docs' stated limitation).");
    if (mixed.buffer) await writeFile(path.join(OUT_DIR, "probe-mixed-multispeaker.wav"), mixed.buffer);
  } else {
    console.log(`Combined multi-speaker call FAILED, as documented: ${mixed.error}`);
  }

  console.log("\n=== Chunking-necessity probe (binary search on full transcript) ===");
  const probe = await findMaxWorkingPrefix(client, model, turns, firstVoice);
  console.log(
    `Max working single-call prefix: ${probe.maxTurns}/${turns.length} turns` +
      ` — chunking ${probe.chunkingNecessary ? "IS" : "is NOT"} necessary for an episode this long.`,
  );
  await writeFile(path.join(OUT_DIR, "probe-results.json"), JSON.stringify(probe.attempts, null, 2));

  console.log("\n=== Demo synthesis ===");
  const demoTurns = args.all ? turns : turns.slice(0, args.turns ?? DEFAULT_DEMO_TURNS);
  console.log(
    `Synthesizing ${demoTurns.length}/${turns.length} turns (${wordCount(demoTurns)} words)` +
      (args.all ? "" : " — pass --all for the whole episode, or --turns=N for a different sample size"),
  );
  const { buffers, calls } = await synthesizeDemo(client, model, demoTurns, speakerVoices, mixed.ok);
  const finalWav = buffers.length === 1 ? buffers[0]! : concatWavBuffers(buffers);
  const outPath = path.join(OUT_DIR, `episode-${episode.id}-demo.wav`);
  await writeFile(outPath, finalWav);
  const { fmt, pcm } = extractPcm(finalWav);
  console.log(`Wrote ${outPath} (${durationSeconds(fmt, pcm.length).toFixed(1)}s across ${calls} API call(s))`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(errorMessage(err));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
