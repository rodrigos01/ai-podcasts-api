import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { listEpisodes } from "../data/episode.repository";
import { createPodcast, deletePodcast, listPodcasts, updatePodcast } from "../data/podcast.repository";
import { requireUserId } from "../middleware/requireAuth";
import type { PodcastOption } from "../schemas/wizard.schema";
import { podcastCreateRequestSchema, podcastUpdateSchema } from "../schemas/podcast.schema";
import {
  podcastWizardOptionsRequestSchema,
  podcastWizardReviseRequestSchema,
} from "../schemas/wizard.schema";
import { prepareHostsForUpdate, withVoicePrompt, withVoicePromptIfPossible } from "../services/personEnglish.service";
import { requireOwnedPodcast } from "../services/podcastAccess";
import * as podcastWizardService from "../services/podcastWizard.service";
import { HttpError } from "../utils/HttpError";
import { requireParam } from "../utils/params";
import { presentPodcast, publicOrigin } from "../utils/voicePreview";
import { decideVoice, needsVoiceNow } from "../utils/voiceDecision";
import { designHostVoicesNow } from "../services/episodeGeneration/voiceResolution.service";
import { createVoicePicker, deletePeopleVoices } from "../services/voiceSelection.service";

// The wizard's own output has no voicePrompt (the model never writes it); the
// server adds it so the client can hand it to POST /voices/design.
function withHostVoicePrompts(options: PodcastOption[]) {
  return Promise.all(
    options.map(async (option) => ({ ...option, hosts: await Promise.all(option.hosts.map(withVoicePromptIfPossible)) })),
  );
}

export async function create(req: Request, res: Response) {
  const { sessionId, ...input } = podcastCreateRequestSchema.parse(req.body);
  const ownerId = requireUserId(req);
  const [prepared, picker] = await Promise.all([
    Promise.all(input.hosts.map(withVoicePrompt)),
    createVoicePicker(ownerId, sessionId),
  ]);

  // A picked voice (validated against this wizard session) starts the host
  // with it; anything else, including an unknown id, is designed lazily at the
  // first generation as before.
  const decisions = prepared.map((host) => decideVoice(undefined, host, picker.pick(host.resolvedVoiceId)));
  const hosts = prepared.map((host, i) => ({
    ...host,
    ...(decisions[i]?.voicePrompt ? { voicePrompt: decisions[i].voicePrompt } : {}),
  }));

  const podcast = await createPodcast({ ...input, hosts }, ownerId, decisions.map((d) => d.fields));
  res.status(201).json(presentPodcast(publicOrigin(req), podcast));
  void picker.finish(decisions);
}

export async function list(req: Request, res: Response) {
  const origin = publicOrigin(req);
  res.json((await listPodcasts(requireUserId(req))).map((podcast) => presentPodcast(origin, podcast)));
}

export async function get(req: Request, res: Response) {
  const podcast = await requireOwnedPodcast(requireParam(req.params, "podcastId"), requireUserId(req));
  res.json(presentPodcast(publicOrigin(req), podcast));
}

export async function update(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const ownerId = requireUserId(req);
  const existing = await requireOwnedPodcast(podcastId, ownerId);
  const input = podcastUpdateSchema.parse(req.body);

  if (!input.hosts) {
    const podcast = await updatePodcast(podcastId, input);
    if (!podcast) throw HttpError.notFound("Podcast not found");
    res.json(presentPodcast(publicOrigin(req), podcast));
    return;
  }

  // Voice picks in an edit come from the podcast's own design session (the
  // session id is the podcast id). Cleanup only runs when hosts are sent.
  const [prepared, picker] = await Promise.all([
    prepareHostsForUpdate(existing.hosts, input.hosts),
    createVoicePicker(ownerId, podcastId),
  ]);
  const currentById = new Map(existing.hosts.map((host) => [host.id, host]));
  const decisions = prepared.map((host) =>
    decideVoice(host.id ? currentById.get(host.id) : undefined, host, picker.pick(host.resolvedVoiceId)),
  );
  const hosts = prepared.map((host, i) => ({
    ...host,
    ...(decisions[i]?.voicePrompt ? { voicePrompt: decisions[i].voicePrompt } : {}),
  }));

  const podcast = await updatePodcast(podcastId, { ...input, hosts }, decisions.map((d) => d.fields));
  if (!podcast) throw HttpError.notFound("Podcast not found");
  res.json(presentPodcast(publicOrigin(req), podcast));
  void picker.finish(decisions);

  // Hosts this save left without a voice get one designed now, not at the
  // next generation (which still designs any that are missing).
  const needVoice = podcast.hosts.filter((saved, i) => {
    const decision = decisions[i];
    const hostId = prepared[i]?.id;
    return !!decision && needsVoiceNow(hostId ? currentById.get(hostId) : undefined, decision, saved);
  });
  if (needVoice.length > 0) void designHostVoicesNow(podcastId, needVoice);
}

export async function remove(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const podcast = await requireOwnedPodcast(podcastId, requireUserId(req));
  const episodes = await listEpisodes(podcastId);
  await deletePodcast(podcastId);
  res.status(204).send();
  void deletePeopleVoices(podcast.hosts, "host");
  void deletePeopleVoices(episodes.flatMap((episode) => episode.guests), "guest");
}

export async function wizardOptions(req: Request, res: Response) {
  const input = podcastWizardOptionsRequestSchema.parse(req.body);
  const options = await podcastWizardService.generateOptions(input.prompt, input.sourceMaterial);
  // Voice-design session for this wizard run — see voiceDesign.service.ts.
  res.json({ sessionId: randomUUID(), options: await withHostVoicePrompts(options) });
}

export async function wizardRevise(req: Request, res: Response) {
  const input = podcastWizardReviseRequestSchema.parse(req.body);
  const options = await podcastWizardService.reviseOptions(
    input.options,
    input.instruction,
    input.targetIndex,
  );
  res.json({ sessionId: input.sessionId ?? randomUUID(), options: await withHostVoicePrompts(options) });
}
