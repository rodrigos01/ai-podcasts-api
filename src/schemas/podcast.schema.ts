import { z } from "zod";
import { languageCodeSchema } from "./common.schema";
import { personSaveSchema, personSchema } from "./person.schema";

export const podcastCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  structure: z.string().min(1),
  hosts: z.array(personSaveSchema).min(1),
  // Free-text, user-written instructions applied on top of the description and
  // structure when drafting and writing episodes. Optional; blank means unset.
  extraInstructions: z.string().optional(),
  // What the wizard returned with the option (see wizard.schema.ts). Used for
  // every voice design for this podcast's hosts and guests; absent on
  // podcasts created before it existed, whose voices are designed without one.
  languageCode: languageCodeSchema,
  // A/B switch for how script generation and the episode drafts learn the
  // series so far: absent/false puts earlier transcripts in the prompt; true
  // chains each call from the previous episode's stored Interactions API
  // interaction instead (services/episodeGeneration/continuity.ts).
  useInteractionContext: z.boolean().optional(),
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
  // An empty string clears the stored instructions.
  extraInstructions: z.string().optional(),
  languageCode: languageCodeSchema,
  useInteractionContext: z.boolean().optional(),
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
