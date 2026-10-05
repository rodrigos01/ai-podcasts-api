import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { createPodcast, deletePodcast, listPodcasts, updatePodcast } from "../data/podcast.repository";
import { requireUserId } from "../middleware/requireAuth";
import { podcastCreateSchema, podcastUpdateSchema } from "../schemas/podcast.schema";
import {
  podcastWizardOptionsRequestSchema,
  podcastWizardReviseRequestSchema,
} from "../schemas/wizard.schema";
import { prepareHostsForUpdate, withEnglishFields } from "../services/personEnglish.service";
import { requireOwnedPodcast } from "../services/podcastAccess";
import * as podcastWizardService from "../services/podcastWizard.service";
import { HttpError } from "../utils/HttpError";
import { requireParam } from "../utils/params";

export async function create(req: Request, res: Response) {
  const input = podcastCreateSchema.parse(req.body);
  const hosts = await Promise.all(input.hosts.map(withEnglishFields));
  const podcast = await createPodcast({ ...input, hosts }, requireUserId(req));
  res.status(201).json(podcast);
}

export async function list(req: Request, res: Response) {
  res.json(await listPodcasts(requireUserId(req)));
}

export async function get(req: Request, res: Response) {
  const podcast = await requireOwnedPodcast(requireParam(req.params, "podcastId"), requireUserId(req));
  res.json(podcast);
}

export async function update(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const existing = await requireOwnedPodcast(podcastId, requireUserId(req));
  const input = podcastUpdateSchema.parse(req.body);
  const hosts = input.hosts ? await prepareHostsForUpdate(existing.hosts, input.hosts) : undefined;
  const podcast = await updatePodcast(podcastId, { ...input, ...(hosts ? { hosts } : {}) });
  if (!podcast) throw HttpError.notFound("Podcast not found");
  res.json(podcast);
}

export async function remove(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  await deletePodcast(podcastId);
  res.status(204).send();
}

export async function wizardOptions(req: Request, res: Response) {
  const input = podcastWizardOptionsRequestSchema.parse(req.body);
  const options = await podcastWizardService.generateOptions(input.prompt, input.sourceMaterial);
  // Voice-design session for this wizard run — see voiceDesign.service.ts.
  res.json({ sessionId: randomUUID(), options });
}

export async function wizardRevise(req: Request, res: Response) {
  const input = podcastWizardReviseRequestSchema.parse(req.body);
  const options = await podcastWizardService.reviseOptions(
    input.options,
    input.instruction,
    input.targetIndex,
  );
  res.json({ sessionId: input.sessionId ?? randomUUID(), options });
}
