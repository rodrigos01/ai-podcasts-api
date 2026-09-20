import { z } from "zod";
import { episodeLengthSchema } from "./common.schema";
import { personInputSchema } from "./person.schema";

export const podcastOptionSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  structure: z.string().min(1),
  hosts: z.array(personInputSchema).min(1).max(4),
  predictedChanges: z.array(z.string().min(1)).length(3),
});

export const podcastOptionsResponseSchema = z.object({
  options: z.array(podcastOptionSchema).length(3),
});

export type PodcastOption = z.infer<typeof podcastOptionSchema>;
export type PodcastOptionsResponse = z.infer<typeof podcastOptionsResponseSchema>;

export const podcastWizardOptionsRequestSchema = z.object({
  prompt: z.string().min(1),
  sourceMaterial: z.string().optional(),
});

export const podcastWizardReviseRequestSchema = z.object({
  options: z.array(podcastOptionSchema).length(3),
  targetIndex: z.number().int().min(0).max(2).optional(),
  instruction: z.string().min(1),
});

export type PodcastWizardOptionsRequest = z.infer<typeof podcastWizardOptionsRequestSchema>;
export type PodcastWizardReviseRequest = z.infer<typeof podcastWizardReviseRequestSchema>;

// Episode wizard suggests a single draft (not 3 parallel options, unlike the
// podcast wizard) — matches specs.md's "Episode Creation" step 2 wording.
export const episodeDraftSchema = z.object({
  title: z.string().min(1),
  topics: z.string().min(1),
  productionNotes: z.string().min(1),
  guests: z.array(personInputSchema).max(1),
  // Purely a UI hint — the client pre-selects this length in its picker,
  // but confirming the episode (episodeCreateSchema below) still requires
  // an explicit `length`; this is never applied automatically server-side.
  suggestedLength: episodeLengthSchema,
  predictedChanges: z.array(z.string().min(1)).length(3),
});

export const episodeWizardOptionsRequestSchema = z.object({
  prompt: z.string().optional(),
  sourceIds: z.array(z.string().min(1)),
});

export const episodeWizardReviseRequestSchema = z.object({
  draft: episodeDraftSchema,
  instruction: z.string().min(1),
});

export type EpisodeDraft = z.infer<typeof episodeDraftSchema>;
export type EpisodeWizardOptionsRequest = z.infer<typeof episodeWizardOptionsRequestSchema>;
export type EpisodeWizardReviseRequest = z.infer<typeof episodeWizardReviseRequestSchema>;
