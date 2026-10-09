import { z } from "zod";
import { clearableText, episodeLengthSchema, optionalText } from "./common.schema";
import { personSaveSchema, personSchema } from "./person.schema";

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
    guests: z.array(personSaveSchema).max(1),
    productionNotes: optionalText,
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
  // The voice-design session the wizard handed out (see voices.controller.ts's
  // design): lets the guests' picked voices be validated and the session's
  // unused candidates deleted. Optional — without it nothing is picked or cleaned.
  sessionId: z.string().min(1).max(128).optional(),
});

export const episodeUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  topics: z.string().min(1).optional(),
  productionNotes: clearableText,
  // Edit the episode's guest(s). The cast size can't change (the 2-voice
  // rule), so this must have as many entries as the episode has guests; an
  // entry with no id is a new person replacing one. The session for voice
  // picks is the episode id.
  guests: z.array(personSaveSchema.extend({ id: z.string().min(1).optional() })).max(1).optional(),
});

export const episodeProgressSchema = z.object({
  stage: z.enum(["kickoff", "conversation", "chunking", "done"]),
  currentWordCount: z.number().int().nonnegative().optional(),
  targetWordRange: z.object({ min: z.number(), max: z.number() }).optional(),
});

export const ttsChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  startTurnIndex: z.number().int().nonnegative(),
  endTurnIndex: z.number().int().nonnegative(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  turnCount: z.number().int().positive(),
});

export const episodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  topics: z.string().min(1),
  length: episodeLengthSchema,
  sourceIds: z.array(z.string().min(1)),
  participantHostIds: z.array(z.string().min(1)),
  guests: z.array(personSchema),
  productionNotes: z.string().min(1).optional(),
  // "streamable" is no longer set by generation itself (the script is written,
  // chunked, and marked "ready" in one step now that there's no condensation
  // pass after it) but stays in the enum: clients treat both "streamable" and
  // "ready" as "go ahead and hit /stream", and older episode docs may hold it.
  status: z.enum(["generating", "streamable", "ready", "failed"]),
  progress: episodeProgressSchema.nullable(),
  transcript: z.string().nullable(),
  ttsChunks: z.array(ttsChunkSchema).nullable(),
  // Total audio duration generated so far, in seconds — updated in
  // Firestore as chunks finish generating (audio.service.ts), not computed
  // at request time, so polling clients (GET .../status) can build a "how
  // far can I scrub" UI without probing GCS themselves. Reads of episodes
  // created before this field existed get `undefined` here (Firestore is
  // schemaless and this isn't backfilled) — treat as 0.
  generatedAudioSeconds: z.number().nonnegative(),
  // True once every TTS chunk is cached, i.e. the audio is a finished, fixed-
  // length file. `generatedAudioSeconds` alone can't say this (it only says how
  // much exists so far), and clients can't infer it from the stream either: a
  // live response that gets cut short looks like a complete file of whatever
  // length arrived. `audioDurationSeconds` is the exact total, set together
  // with it. Both are absent on episodes created before they existed until
  // their audio is next streamed in full (audio.service.ts backfills them).
  // Bumped each time the episode's audio is cleared; a generation started under an
  // older value stops (see utils/audioCancellation.ts). Absent means 0.
  audioEpoch: z.number().int().nonnegative().optional(),
  audioComplete: z.boolean().optional(),
  audioDurationSeconds: z.number().nonnegative().nullable().optional(),
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
