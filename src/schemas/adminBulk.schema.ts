import { z } from "zod";

const ids = z
  .array(z.string().min(1))
  .min(1)
  .max(200)
  .transform((list) => [...new Set(list)]);

export const changeOwnerRequestSchema = z.object({
  podcastIds: ids,
  ownerId: z.string().min(1),
});

export const regenerateEpisodesRequestSchema = z.object({
  podcastId: z.string().min(1),
  episodeIds: ids,
  // Also draft each episode again (title, topics, notes, guest) before its script.
  redraft: z.boolean().default(false),
});
