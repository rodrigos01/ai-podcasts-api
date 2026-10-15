import { z } from "zod";
import { languageCodeSchema } from "./common.schema";
import { personSaveSchema, personSchema } from "./person.schema";

// How script generation learns what happened in earlier episodes (see
// services/episodeGeneration/continuity.ts): their full transcripts in the
// prompt, a chain of stored Interactions API calls, or notes written about
// them by an intermediary LLM call. Absent = "transcripts".
export const historyMethodSchema = z.enum(["transcripts", "interaction", "notes"]);
export type HistoryMethod = z.infer<typeof historyMethodSchema>;

// Where that history goes in the script call: the system instruction (default)
// or the prompt, which leaves the system instruction identical for every
// episode of the show.
export const historyPlacementSchema = z.enum(["system", "prompt"]);
export type HistoryPlacement = z.infer<typeof historyPlacementSchema>;

export const podcastCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  structure: z.string().min(1),
  hosts: z.array(personSaveSchema).min(1),
  // What the wizard returned with the option (see wizard.schema.ts). Used for
  // every voice design for this podcast's hosts and guests; absent on
  // podcasts created before it existed, whose voices are designed without one.
  languageCode: languageCodeSchema,
  historyMethod: historyMethodSchema.optional(),
  historyPlacement: historyPlacementSchema.optional(),
  // Adds a rule to the system instruction that earlier episodes are shared
  // history, not a template for this one (catchphrases excepted).
  historyTemplateRule: z.boolean().optional(),
});

// POST /podcasts also takes the wizard's voice-design session id, which lets
// the hosts' picked voices be validated and the session's unused candidates
// deleted; optional — without it nothing is picked or cleaned.
export const podcastCreateRequestSchema = podcastCreateSchema.extend({
  sessionId: z.string().min(1).max(128).optional(),
});

// On update, an existing host keeps its id (passed back by the client) so
// episodes' participantHostIds stay valid; a host with no id is treated as
// newly added and gets a fresh one in the repository layer.
const hostUpdateInputSchema = personSaveSchema.extend({
  id: z.string().min(1).optional(),
});

export const podcastUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  structure: z.string().min(1).optional(),
  hosts: z.array(hostUpdateInputSchema).min(1).optional(),
  languageCode: languageCodeSchema,
  historyMethod: historyMethodSchema.optional(),
  historyPlacement: historyPlacementSchema.optional(),
  historyTemplateRule: z.boolean().optional(),
});

export const podcastSchema = podcastCreateSchema.extend({
  id: z.string().min(1),
  hosts: z.array(personSchema).min(1),
  ownerId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type PodcastCreateInput = z.infer<typeof podcastCreateSchema>;
export type PodcastUpdateInput = z.infer<typeof podcastUpdateSchema>;
export type Podcast = z.infer<typeof podcastSchema>;
