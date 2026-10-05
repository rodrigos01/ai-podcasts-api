import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import {
  createEpisode,
  deleteEpisode,
  getEpisode,
  getPriorEpisodes,
  listEpisodes,
  updateEpisode,
} from "../data/episode.repository";
import { MAX_HISTORY_EPISODES } from "../constants/episodeHistory";
import { getSource } from "../data/source.repository";
import { requireUserId } from "../middleware/requireAuth";
import { episodeCreateRequestSchema, episodeUpdateSchema } from "../schemas/episode.schema";
import {
  type EpisodeWizardSuggestionsResponse,
  episodeWizardOptionsRequestSchema,
  episodeWizardReviseRequestSchema,
} from "../schemas/wizard.schema";
import {
  runEpisodeGeneration,
  runEpisodeGenerationSequence,
} from "../services/episodeGeneration/orchestrator";
import * as episodeWizardService from "../services/episodeWizard.service";
import { prepareHostsForUpdate, withVoicePrompt, withVoicePromptIfPossible } from "../services/personEnglish.service";
import { requireOwnedPodcast } from "../services/podcastAccess";
import { HttpError } from "../utils/HttpError";
import { requireParam } from "../utils/params";
import { decideVoice } from "../utils/voiceDecision";
import { createVoicePicker, deletePeopleVoices } from "../services/voiceSelection.service";

// The wizard's own output has no voicePrompt (the model never writes it); the
// server adds it so the client can hand it to POST /voices/design.
async function withGuestVoicePrompts(result: EpisodeWizardSuggestionsResponse) {
  return {
    suggestions: await Promise.all(
      result.suggestions.map(async (suggestion) => ({
        episodes: await Promise.all(
          suggestion.episodes.map(async (episode) => ({
            ...episode,
            guests: await Promise.all(episode.guests.map(withVoicePromptIfPossible)),
          })),
        ),
      })),
    ),
  };
}

export async function wizardOptions(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const podcast = await requireOwnedPodcast(podcastId, requireUserId(req));
  const input = episodeWizardOptionsRequestSchema.parse(req.body);

  const sources = (
    await Promise.all(input.sourceIds.map((sourceId) => getSource(podcastId, sourceId)))
  ).filter((s): s is NonNullable<typeof s> => s !== null);

  const previousEpisodes = await getPriorEpisodes(podcastId, undefined, MAX_HISTORY_EPISODES);
  const result = await episodeWizardService.generateSuggestions(
    podcast,
    sources,
    input.length,
    previousEpisodes,
    input.prompt,
  );
  // Voice-design session for this wizard run — see voiceDesign.service.ts.
  res.json({ sessionId: randomUUID(), ...(await withGuestVoicePrompts(result)) });
}

export async function wizardRevise(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const podcast = await requireOwnedPodcast(podcastId, requireUserId(req));
  const input = episodeWizardReviseRequestSchema.parse(req.body);
  const previousEpisodes = await getPriorEpisodes(podcastId, undefined, MAX_HISTORY_EPISODES);
  const result = await episodeWizardService.reviseSuggestions(
    podcast,
    input.suggestions,
    input.length,
    previousEpisodes,
    input.targetSuggestionIndex,
    input.targetEpisodeIndex,
    input.instruction,
  );
  res.json({ sessionId: input.sessionId ?? randomUUID(), ...(await withGuestVoicePrompts(result)) });
}

export async function create(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  const ownerId = requireUserId(req);
  await requireOwnedPodcast(podcastId, ownerId);
  const input = episodeCreateRequestSchema.parse(req.body);
  const picker = await createVoicePicker(ownerId, input.sessionId);

  const episodes = [];
  const decisions = [];
  for (const episodeInput of input.episodes) {
    const prepared = await Promise.all(episodeInput.guests.map(withVoicePrompt));
    // A picked voice (validated against this wizard session) starts the guest
    // with it; anything else is designed at generation as before.
    const guestDecisions = prepared.map((guest) => decideVoice(undefined, guest, picker.pick(guest.resolvedVoiceId)));
    const guests = prepared.map((guest, i) => ({
      ...guest,
      ...(guestDecisions[i]?.voicePrompt ? { voicePrompt: guestDecisions[i].voicePrompt } : {}),
    }));
    decisions.push(...guestDecisions);
    episodes.push(
      await createEpisode(podcastId, { ...episodeInput, guests }, guestDecisions.map((d) => d.fields)),
    );
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
  void picker.finish(decisions);
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
  const episodeId = requireParam(req.params, "episodeId");
  const ownerId = requireUserId(req);
  await requireOwnedPodcast(podcastId, ownerId);
  const input = episodeUpdateSchema.parse(req.body);

  if (!input.guests) {
    const episode = await updateEpisode(podcastId, episodeId, input);
    if (!episode) throw HttpError.notFound("Episode not found");
    res.json(episode);
    return;
  }

  const existing = await getEpisode(podcastId, episodeId);
  if (!existing) throw HttpError.notFound("Episode not found");
  if (input.guests.length !== existing.guests.length) {
    throw HttpError.badRequest("An episode's cast size can't change: send as many guests as it has.");
  }

  // Voice picks in an edit come from the episode's own design session (the
  // session id is the episode id). Cleanup only runs when guests are sent.
  const [prepared, picker] = await Promise.all([
    prepareHostsForUpdate(existing.guests, input.guests),
    createVoicePicker(ownerId, episodeId),
  ]);
  const currentById = new Map(existing.guests.map((guest) => [guest.id, guest]));
  const decisions = prepared.map((guest) =>
    decideVoice(guest.id ? currentById.get(guest.id) : undefined, guest, picker.pick(guest.resolvedVoiceId)),
  );
  const guests = prepared.map((guest, i) => ({
    ...guest,
    ...(decisions[i]?.voicePrompt ? { voicePrompt: decisions[i].voicePrompt } : {}),
  }));

  const episode = await updateEpisode(podcastId, episodeId, { ...input, guests }, decisions.map((d) => d.fields));
  if (!episode) throw HttpError.notFound("Episode not found");
  res.json(episode);
  void picker.finish(decisions);
}

export async function remove(req: Request, res: Response) {
  const podcastId = requireParam(req.params, "podcastId");
  await requireOwnedPodcast(podcastId, requireUserId(req));
  const episodeId = requireParam(req.params, "episodeId");
  const episode = await getEpisode(podcastId, episodeId);
  const deleted = await deleteEpisode(podcastId, episodeId);
  if (!deleted) throw HttpError.notFound("Episode not found");
  res.status(204).send();
  if (episode) void deletePeopleVoices(episode.guests, "guest");
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
