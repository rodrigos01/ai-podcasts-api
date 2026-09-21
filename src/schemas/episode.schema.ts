import { z } from "zod";
import { episodeLengthSchema } from "./common.schema";
import { personInputSchema, personSchema } from "./person.schema";

// Per specs.md: an episode has exactly 2 active voices — 2 hosts, or 1 host
// + 1 guest. There is no "solo host" mode and no more than 2 at once.
function twoVoiceCast(ctx: {
  value: { participantHostIds: string[]; guests: unknown[] };
  issues: z.core.$ZodRawIssue[];
}) {
  if (ctx.value.participantHostIds.length + ctx.value.guests.length !== 2) {
    ctx.issues.push({
      code: "custom",
      message: "An episode must cast exactly 2 voices: 2 hosts, or 1 host + 1 guest.",
      path: ["participantHostIds"],
      input: ctx.value,
    });
  }
}

export const episodeCreateSchema = z
  .object({
    title: z.string().min(1),
    topics: z.string().min(1),
    length: episodeLengthSchema,
    sourceIds: z.array(z.string().min(1)),
    participantHostIds: z.array(z.string().min(1)).max(2),
    guests: z.array(personInputSchema).max(1),
    productionNotes: z.string().min(1),
  })
  .check(twoVoiceCast);

// Confirming an episode always takes the whole wizard suggestion at once —
// 1 entry for a single episode, or 2 for a confirmed split — never a bare
// single-episode object. The server creates all of them immediately and
// generates them sequentially in the background (see
// episodeGeneration/orchestrator.ts's runEpisodeGenerationSequence); the
// sequencing is transparent to the caller, who just gets back every created
// episode in one response and polls each one's own status as usual.
export const episodeCreateRequestSchema = z.object({
  episodes: z.array(episodeCreateSchema).min(1).max(2),
});

export const episodeUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  topics: z.string().min(1).optional(),
  productionNotes: z.string().min(1).optional(),
});

export const episodeProgressSchema = z.object({
  stage: z.enum([
    "kickoff",
    "producer_prompt",
    "conversation",
    "chunking",
    "condensation",
    "done",
  ]),
  currentWordCount: z.number().int().nonnegative().optional(),
  targetWordRange: z.object({ min: z.number(), max: z.number() }).optional(),
});

export const ttsChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
});

export const episodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  topics: z.string().min(1),
  length: episodeLengthSchema,
  sourceIds: z.array(z.string().min(1)),
  participantHostIds: z.array(z.string().min(1)),
  guests: z.array(personSchema),
  productionNotes: z.string().min(1),
  // "streamable" sits between "generating" and "ready": the episode's
  // script has been written and chunked (see
  // episodeGeneration/scriptGeneration.service.ts and chunker.ts), so
  // /stream will serve audio, but condensation may still be in progress.
  // Clients should treat both "streamable" and "ready" as "go ahead and hit
  // /stream" — the difference is only whether more is still being generated.
  status: z.enum(["generating", "streamable", "ready", "failed"]),
  progress: episodeProgressSchema.nullable(),
  transcript: z.string().nullable(),
  ttsPrompt: z.string().nullable(),
  ttsChunks: z.array(ttsChunkSchema).nullable(),
  // Total audio duration generated and cached so far, in seconds — updated
  // in Firestore once per chunk as it finishes generating (audio.service.ts),
  // not computed at request time, so polling clients (GET .../status) can
  // build a "how far can I scrub" UI without probing GCS themselves. Reads
  // of episodes created before this field existed get `undefined` here
  // (Firestore is schemaless and this isn't backfilled) — treat as 0.
  generatedAudioSeconds: z.number().nonnegative(),
  condensedSummaries: z.record(z.string(), z.string()).nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type EpisodeCreateInput = z.infer<typeof episodeCreateSchema>;
export type EpisodeCreateRequest = z.infer<typeof episodeCreateRequestSchema>;
export type EpisodeUpdateInput = z.infer<typeof episodeUpdateSchema>;
export type Episode = z.infer<typeof episodeSchema>;
export type EpisodeProgress = z.infer<typeof episodeProgressSchema>;
export type TtsChunk = z.infer<typeof ttsChunkSchema>;
