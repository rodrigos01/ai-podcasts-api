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

// A single episode draft — one entry of an EpisodeSuggestion's `episodes`
// array below. `length` is chosen by the client up front (see
// episodeWizardOptionsRequestSchema) and used to shape this draft, not
// suggested afterward — there is no more `suggestedLength` output hint.
export const episodeDraftSchema = z.object({
  title: z.string().min(1),
  topics: z.string().min(1),
  productionNotes: z.string().min(1),
  guests: z.array(personInputSchema).max(1),
  predictedChanges: z.array(z.string().min(1)).length(3),
});

// One suggestion is either a single episode or a natural 2-episode split —
// whichever the drafter judges right for it (see
// episodeWizard.prompts.ts for when each applies, e.g. the user's own
// prompt asking for the material to be split). There is no positional
// convention: a suggestion's episode count says nothing about whether it's
// the first or second entry in the array below, and a lone suggestion is
// just as free to be a split as a single episode.
export const episodeSuggestionSchema = z.object({
  episodes: z.array(episodeDraftSchema).min(1).max(2),
});

// Always an array of 1-2 independent suggestions, each itself either a
// single episode or a 2-episode split — see episodeSuggestionSchema above.
// A second suggestion, when present, is just a genuinely useful alternative
// worth offering side by side with the first (e.g. a tight single episode
// vs. a fuller two-part treatment) — it is NOT required to differ in
// episode count from the first, and the first is NOT required to be the
// single-episode option. Don't reintroduce a positional invariant here (an
// earlier version did, via a `.check()` refinement, and it hard-rejected
// perfectly valid responses that just didn't match that assumed
// convention) — every entry's shape is fully described by its own
// `episodes.length`, which is all a client should ever key off.
export const episodeWizardOptionsResponseSchema = z.object({
  suggestions: z.array(episodeSuggestionSchema).min(1).max(2),
});

export const episodeWizardOptionsRequestSchema = z.object({
  prompt: z.string().optional(),
  sourceIds: z.array(z.string().min(1)),
  // Chosen before drafting starts (moved up from a post-hoc `suggestedLength`
  // hint) so the drafter can structure the episode for this target from the
  // outset, and so it can tell when the target is too short for the
  // material and offer a split suggestion instead.
  length: episodeLengthSchema,
});

export const episodeWizardReviseRequestSchema = z.object({
  suggestions: z.array(episodeSuggestionSchema).min(1).max(2),
  length: episodeLengthSchema,
  targetSuggestionIndex: z.number().int().min(0).max(1),
  // Omit to revise every episode within that suggestion; set to revise just
  // one (e.g. only part 2 of a split).
  targetEpisodeIndex: z.number().int().min(0).max(1).optional(),
  instruction: z.string().min(1),
});

export type EpisodeDraft = z.infer<typeof episodeDraftSchema>;
export type EpisodeSuggestion = z.infer<typeof episodeSuggestionSchema>;
export type EpisodeWizardOptionsRequest = z.infer<typeof episodeWizardOptionsRequestSchema>;
export type EpisodeWizardSuggestionsResponse = z.infer<typeof episodeWizardOptionsResponseSchema>;
export type EpisodeWizardReviseRequest = z.infer<typeof episodeWizardReviseRequestSchema>;
