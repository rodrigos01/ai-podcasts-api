import type { Request, Response } from "express";
import {
  createEpisode,
  deleteEpisode,
  getEpisode,
  listEpisodes,
  updateEpisode,
} from "../data/episode.repository";
import { getSource } from "../data/source.repository";
import { requireUserId } from "../middleware/requireAuth";
import { episodeCreateRequestSchema, episodeUpdateSchema } from "../schemas/episode.schema";
import {
  episodeWizardOptionsRequestSchema,
  episodeWizardReviseRequestSchema,
} from "../schemas/wizard.schema";
import {
  runEpisodeGeneration,
  runEpisodeGenerationSequence,
} from "../services/episodeGeneration/orchestrator";
import * as episodeWizardService from "../services/episodeWizard.service";
import { requireOwnedPodcast } from "../services/podcastAccess";
import { HttpError } from "../utils/HttpError";
import { requireParam } from "../utils/params";

export async function wizardOptions(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const podcast = await requireOwnedPodcast(podcastId, requireUserId(req));
  const input = episodeWizardOptionsRequestSchema.parse(req.body);

  const sources = (
    await Promise.all(input.sourceIds.map((sourceId) => getSource(podcastId, sourceId)))
  ).filter((s): s is NonNullable<typeof s> => s !== null);

  const result = await episodeWizardService.generateSuggestions(
    podcast,
    sources,
    input.length,
    input.prompt,
  );
  res.json(result);
}

export async function wizardRevise(req: Request, res: Response) {
  const podcast = await requireOwnedPodcast(requireParam(req.params, "podcastId"), requireUserId(req));
  const input = episodeWizardReviseRequestSchema.parse(req.body);
  const result = await episodeWizardService.reviseSuggestions(
    podcast,
    input.suggestions,
    input.length,
    input.targetSuggestionIndex,
    input.targetEpisodeIndex,
    input.instruction,
  );
  res.json(result);
}

export async function create(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  const input = episodeCreateRequestSchema.parse(req.body);

  const episodes = [];
  for (const episodeInput of input.episodes) {
    episodes.push(await createEpisode(podcastId, episodeInput));
  }

  // Every episode is created and returned immediately; generation itself
  // runs sequentially in the background (part 2, if any, only actually
  // starts once part 1 is "ready") — see orchestrator.ts's
  // runEpisodeGenerationSequence for why. The caller doesn't do anything
  // differently for a split vs. a single episode.
  void runEpisodeGenerationSequence(
    podcastId,
    episodes.map((episode) => episode.id),
  ).catch((err: unknown) => {
    console.error(`Episode generation sequence failed for ${podcastId}:`, err);
  });

  res.status(202).json({ episodes });
}

export async function list(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  res.json(await listEpisodes(podcastId));
}

export async function get(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  const episode = await getEpisode(podcastId, requireParam(req.params, "episodeId"));
  if (!episode) throw HttpError.notFound("Episode not found");
  res.json(episode);
}

export async function status(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  const episode = await getEpisode(podcastId, requireParam(req.params, "episodeId"));
  if (!episode) throw HttpError.notFound("Episode not found");
  res.json({
    status: episode.status,
    progress: episode.progress,
    error: episode.error,
    // Undefined for an episode created before this field existed (no
    // backfill) — coalesce so polling clients always get a usable number.
    generatedAudioSeconds: episode.generatedAudioSeconds ?? 0,
  });
}

export async function update(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  const input = episodeUpdateSchema.parse(req.body);
  const episode = await updateEpisode(podcastId, requireParam(req.params, "episodeId"), input);
  if (!episode) throw HttpError.notFound("Episode not found");
  res.json(episode);
}

export async function remove(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  const deleted = await deleteEpisode(podcastId, requireParam(req.params, "episodeId"));
  if (!deleted) throw HttpError.notFound("Episode not found");
  res.status(204).send();
}

export async function regenerate(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  const episodeId = requireParam(req.params, "episodeId");
  const episode = await getEpisode(podcastId, episodeId);
  if (!episode) throw HttpError.notFound("Episode not found");

  // Regenerating a "ready" episode is deliberately allowed — a fresh
  // script/transcript (and, downstream, fresh audio) even when the last
  // attempt fully succeeded, e.g. after a chunking/prompt change, or
  // because the user just wants a different take. orchestrator.ts's
  // runEpisodeGeneration resets the episode's transcript/chunks/cached
  // audio back to a clean slate as its first step, so this is safe to
  // fire regardless of the episode's current status.
  void runEpisodeGeneration(podcastId, episodeId).catch((err: unknown) => {
    console.error(`Episode regeneration failed for ${podcastId}/${episodeId}:`, err);
  });

  res.status(202).json({ status: "generating" });
}
