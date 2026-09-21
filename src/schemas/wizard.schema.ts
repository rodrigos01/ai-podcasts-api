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

// One suggestion is either a single episode (the drafter's best-effort fit
// to the requested length) or, when that length is genuinely too short for
// the source material, a natural 2-episode split.
export const episodeSuggestionSchema = z.object({
  episodes: z.array(episodeDraftSchema).min(1).max(2),
});

// Always an array: exactly 1 suggestion (a single episode) when the
// requested length comfortably fits the material, or exactly 2 — the first
// a single-episode best-effort fit, the second a 2-episode split — when it
// doesn't. Enforced here (not left to prompting alone) so clients can rely
// on the shape: suggestions[0] is always the single-episode option;
// suggestions[1], if present, is always the split.
function suggestionsShape(ctx: {
  value: { suggestions: { episodes: unknown[] }[] };
  issues: z.core.$ZodRawIssue[];
}) {
  const { suggestions } = ctx.value;
  const invalid =
    suggestions.length < 1 ||
    suggestions.length > 2 ||
    suggestions[0]?.episodes.length !== 1 ||
    (suggestions.length === 2 && suggestions[1]?.episodes.length !== 2);
  if (invalid) {
    ctx.issues.push({
      code: "custom",
      message:
        "suggestions must be [singleEpisode] or [singleEpisode, twoEpisodeSplit] — 1 or 2 entries, " +
        "the first with exactly 1 episode and the (optional) second with exactly 2.",
      path: ["suggestions"],
      input: ctx.value,
    });
  }
}

export const episodeWizardOptionsRequestSchema = z.object({
  prompt: z.string().optional(),
  sourceIds: z.array(z.string().min(1)),
  // Chosen before drafting starts (moved up from a post-hoc `suggestedLength`
  // hint) so the drafter can structure the episode for this target from the
  // outset, and so it can tell when the target is too short for the
  // material and offer a split suggestion instead.
  length: episodeLengthSchema,
});

export const episodeWizardOptionsResponseSchema = z
  .object({ suggestions: z.array(episodeSuggestionSchema).min(1).max(2) })
  .check(suggestionsShape);

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
