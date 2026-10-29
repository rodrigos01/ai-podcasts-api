import { getAuth } from "firebase-admin/auth";
import { firebaseApp } from "../config/firebase";
import { clearInteractionIdsAfter, getEpisode, patchEpisodeState } from "../data/episode.repository";
import { getPodcast, setPodcastOwner } from "../data/podcast.repository";
import { HttpError } from "../utils/HttpError";
import { planRegeneration } from "../utils/regenerationPlan";
import { CLEAN_GENERATION_STATE } from "../utils/generationState";
import { runEpisodeGeneration } from "./episodeGeneration/orchestrator";

/**
 * Gives each podcast to `ownerId`, who must be an existing Firebase user (a
 * typo would otherwise hand podcasts to nobody). Returns the ids that were
 * changed and the ones that no longer exist.
 */
export async function changePodcastOwners(podcastIds: string[], ownerId: string) {
  try {
    await getAuth(firebaseApp).getUser(ownerId);
  } catch (err) {
    if ((err as { code?: string }).code === "auth/user-not-found") {
      throw HttpError.badRequest(`No Firebase user with uid "${ownerId}"`);
    }
    throw err;
  }
  const changed: string[] = [];
  const missing: string[] = [];
  for (const podcastId of podcastIds) {
    (await setPodcastOwner(podcastId, ownerId) ? changed : missing).push(podcastId);
  }
  return { changed, missing };
}

/**
 * Queues the episodes of one podcast for regeneration, in series order, one
 * after another: each is chained behind the previous selected one with
 * `startsAfterEpisodeId`, the same mechanism a confirmed two-part suggestion
 * uses, so the chain is driven by the server (it survives the admin closing
 * the page) and a lost run is picked back up by `ensureGenerationRunning`.
 * Every selected episode is reset to "generating" up front (so it shows as
 * queued and nobody can stream its old transcript); only the first starts now,
 * and each one starts the next when it finishes. If one fails, the rest fail
 * with it (`failDependents`) and can be queued again.
 * Returns the episode ids in the order they will run.
 */
export async function enqueueEpisodeRegeneration(
  podcastId: string,
  episodeIds: string[],
  redraft: boolean,
): Promise<string[]> {
  if (!(await getPodcast(podcastId))) throw HttpError.notFound("Podcast not found");
  const found = await Promise.all(episodeIds.map((id) => getEpisode(podcastId, id)));
  const missing = episodeIds.filter((_, i) => !found[i]);
  if (missing.length > 0) throw HttpError.notFound(`Episode not found: ${missing.join(", ")}`);

  const plan = planRegeneration(found.filter((episode) => episode !== null));
  for (const step of plan) {
    await patchEpisodeState(podcastId, step.id, {
      ...CLEAN_GENERATION_STATE,
      redraftPending: redraft,
      ...(step.startsAfterEpisodeId ? { startsAfterEpisodeId: step.startsAfterEpisodeId } : {}),
    });
  }

  // Everything after the earliest selected episode is about to be replaced (or
  // sits on a version about to be), so the stored interactions after it are
  // forgotten now. Each run's own wipe does this too, but a later episode can
  // wait a long time in the queue, and meanwhile a draft in the wizard would
  // continue from a chain holding the old version.
  const [first] = plan;
  const firstEpisode = found.find((episode) => episode?.id === first!.id);
  await clearInteractionIdsAfter(podcastId, { id: first!.id, createdAt: firstEpisode!.createdAt });
  void runEpisodeGeneration(podcastId, first!.id).catch((err: unknown) => {
    console.error(`Bulk regeneration of ${podcastId}/${first!.id} failed:`, err);
  });
  return plan.map((step) => step.id);
}
