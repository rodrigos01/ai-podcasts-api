import { GENERATION_LEASE_TTL_MS } from "../constants/generationLease";
import type { Episode } from "../schemas/episode.schema";

/**
 * Who is generating an episode right now, and when they last proved it. Held
 * by exactly one run at a time (see episode.repository.ts's
 * acquireGenerationLease), so a stalled run and the run that took it over
 * can't both write the episode.
 */
export interface GenerationLease {
  owner: string;
  heartbeatAt: number;
}

/**
 * Thrown to a run that no longer owns its episode's lease (another run took
 * it over after the lease went stale, or the episode was deleted). It must
 * stop quietly — the new owner is the one in charge of the episode now, so
 * the old run must neither retry nor mark the episode failed.
 */
export class GenerationSupersededError extends Error {
  constructor() {
    super("Episode generation was taken over by another run");
    this.name = "GenerationSupersededError";
  }
}

export function isGenerationSuperseded(err: unknown): err is GenerationSupersededError {
  return err instanceof GenerationSupersededError;
}

export function isGenerationLeaseLive(lease: GenerationLease | null | undefined, now: number): boolean {
  return !!lease && now - lease.heartbeatAt < GENERATION_LEASE_TTL_MS;
}

/**
 * An episode that's meant to be generating but has nobody doing it: its
 * status says in progress, and no run holds a live lease. True for an
 * instance that died mid-generation, and also for an episode that hasn't
 * started yet (see `dependencyAction`).
 */
export function needsGenerationRestart(
  episode: Pick<Episode, "status" | "generationLease">,
  now: number,
): boolean {
  const inProgress = episode.status === "generating" || episode.status === "streamable";
  return inProgress && !isGenerationLeaseLive(episode.generationLease, now);
}

export type DependencyAction = "start" | "wait" | "fail";

/**
 * What a later part of a multi-episode suggestion should do given the part it
 * starts after (`startsAfterEpisodeId`): start once that one is "ready" (or
 * gone — nothing left to wait for), wait while it's still being generated,
 * or fail along with it.
 */
export function dependencyAction(predecessor: Pick<Episode, "status"> | null): DependencyAction {
  if (!predecessor || predecessor.status === "ready") return "start";
  if (predecessor.status === "failed") return "fail";
  return "wait";
}
