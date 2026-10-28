import type { Request, Response } from "express";
import { changeOwnerRequestSchema, regenerateEpisodesRequestSchema } from "../schemas/adminBulk.schema";
import { changePodcastOwners, enqueueEpisodeRegeneration } from "../services/adminBulk.service";

export async function changeOwner(req: Request, res: Response) {
  const { podcastIds, ownerId } = changeOwnerRequestSchema.parse(req.body);
  const result = await changePodcastOwners(podcastIds, ownerId);
  console.log(`admin bulk owner change uid=${req.userId} -> ${ownerId} podcasts=${podcastIds.join(",")}`);
  res.json(result);
}

export async function regenerateEpisodes(req: Request, res: Response) {
  const { podcastId, episodeIds, redraft } = regenerateEpisodesRequestSchema.parse(req.body);
  const order = await enqueueEpisodeRegeneration(podcastId, episodeIds, redraft);
  console.log(`admin bulk regenerate uid=${req.userId} ${podcastId} redraft=${redraft} order=${order.join(",")}`);
  res.status(202).json({ order });
}
