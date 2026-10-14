import type { Request } from "express";
import { requireUserId } from "../middleware/requireAuth";
import { getPodcast } from "../data/podcast.repository";
import type { Podcast } from "../schemas/podcast.schema";
import { HttpError } from "../utils/HttpError";

/**
 * Shared by every controller nested under /podcasts/:podcastId (sources,
 * episodes, audio) — a podcast that exists but belongs to someone else is
 * treated identically to one that doesn't exist, so we never leak whether
 * a given id belongs to another user.
 */
export async function requireOwnedPodcast(podcastId: string, userId: string): Promise<Podcast> {
  const podcast = await getPodcast(podcastId);
  if (!podcast || podcast.ownerId !== userId) {
    throw HttpError.notFound("Podcast not found");
  }
  return podcast;
}

/**
 * What the nested controllers call: the caller's own podcast, or any podcast
 * for an admin (requireAdmin sets `req.isAdmin`). A missing podcast is a 404
 * either way.
 */
export async function requireAccessiblePodcast(req: Request, podcastId: string): Promise<Podcast> {
  if (!req.isAdmin) return requireOwnedPodcast(podcastId, requireUserId(req));
  const podcast = await getPodcast(podcastId);
  if (!podcast) throw HttpError.notFound("Podcast not found");
  return podcast;
}
