import { z } from "zod";
import { personSaveSchema, personSchema } from "./person.schema";

export const podcastCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  structure: z.string().min(1),
  hosts: z.array(personSaveSchema).min(1),
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
