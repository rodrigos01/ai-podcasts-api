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
  status: z.enum(["generating", "ready", "failed"]),
  progress: episodeProgressSchema.nullable(),
  transcript: z.string().nullable(),
  ttsPrompt: z.string().nullable(),
  ttsChunks: z.array(ttsChunkSchema).nullable(),
  condensedSummaries: z.record(z.string(), z.string()).nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type EpisodeCreateInput = z.infer<typeof episodeCreateSchema>;
export type EpisodeUpdateInput = z.infer<typeof episodeUpdateSchema>;
export type Episode = z.infer<typeof episodeSchema>;
export type EpisodeProgress = z.infer<typeof episodeProgressSchema>;
export type TtsChunk = z.infer<typeof ttsChunkSchema>;
