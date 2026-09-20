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
import { episodeCreateSchema, episodeUpdateSchema } from "../schemas/episode.schema";
import {
  episodeWizardOptionsRequestSchema,
  episodeWizardReviseRequestSchema,
} from "../schemas/wizard.schema";
import { runEpisodeGeneration } from "../services/episodeGeneration/orchestrator";
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

  const draft = await episodeWizardService.generateDraft(podcast, sources, input.prompt);
  res.json({ draft });
}

export async function wizardRevise(req: Request, res: Response) {
  const podcast = await requireOwnedPodcast(requireParam(req.params, "podcastId"), requireUserId(req));
  const input = episodeWizardReviseRequestSchema.parse(req.body);
  const draft = await episodeWizardService.reviseDraft(podcast, input.draft, input.instruction);
  res.json({ draft });
}

export async function create(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  const input = episodeCreateSchema.parse(req.body);
  const episode = await createEpisode(podcastId, input);

  void runEpisodeGeneration(podcastId, episode.id).catch((err: unknown) => {
    console.error(`Episode generation failed for ${podcastId}/${episode.id}:`, err);
  });

  res.status(202).json(episode);
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
  if (episode.status === "ready") {
    throw HttpError.badRequest("Episode is already ready; nothing to regenerate");
  }

  void runEpisodeGeneration(podcastId, episodeId).catch((err: unknown) => {
    console.error(`Episode regeneration failed for ${podcastId}/${episodeId}:`, err);
  });

  res.status(202).json({ status: "generating" });
}
