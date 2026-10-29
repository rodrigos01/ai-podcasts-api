import { generatePlainTextWithId, PreviousInteractionNotFoundError } from "../../llm/geminiClient";
import { buildCatchUpPrompt } from "../../llm/prompts/episodeHistory.prompts";
import { setInteractionIdIfCurrent } from "../../data/episode.repository";
import type { Podcast } from "../../schemas/podcast.schema";
import type { PriorEpisode } from "../../utils/episodeHistory";

/**
 * How a call (an episode's script, or a draft of the next episode) learns the
 * series so far. Exactly one of the two is ever set:
 *  - `previousEpisodes`: the earlier transcripts go in the prompt (the last
 *    resort, when no chain can be built);
 *  - `previousInteractionId`: the call continues a stored Interactions API
 *    interaction that already holds the series so far, so nothing is sent a
 *    second time ("interaction context", on by default, turned off per
 *    podcast by `useInteractionContext: false`).
 */
export interface Continuity {
  previousEpisodes: PriorEpisode[];
  previousInteractionId?: string;
}

export function usesInteractionContext(podcast: Pick<Podcast, "useInteractionContext">): boolean {
  return podcast.useInteractionContext !== false;
}

/**
 * The stored interaction that holds the series through the latest earlier
 * episode, if there is one. `prior` is the window of earlier episodes with
 * transcripts, oldest first (see utils/episodeHistory.ts). An episode's
 * `interactionId` is only ever kept while everything before it is unchanged
 * (data/episode.repository.ts forgets the ids after an episode that is
 * regenerated or deleted), so an id here is safe to continue from.
 */
export function chainHead(prior: PriorEpisode[]): string | null {
  return prior[prior.length - 1]?.episode.interactionId ?? null;
}

/** What `withContinuity` needs from the outside world, so tests can stand in for it. */
export interface ContinuityDeps {
  /** Sends the transcripts to the model as conversation and returns the id of that interaction. */
  catchUp(podcast: Podcast, prior: PriorEpisode[]): Promise<string>;
  /** Records the id as the series state through `episode`. */
  remember(podcastId: string, episode: PriorEpisode["episode"], interactionId: string): Promise<void>;
}

const CATCH_UP_SYSTEM_INSTRUCTION = (title: string) =>
  `You keep the record of the podcast "${title}". You are given its earlier episodes so that later requests can build on them. Acknowledge them and nothing more.`;

export const defaultContinuityDeps: ContinuityDeps = {
  async catchUp(podcast, prior) {
    const { interactionId } = await generatePlainTextWithId({
      systemInstruction: CATCH_UP_SYSTEM_INSTRUCTION(podcast.title),
      prompt: buildCatchUpPrompt(prior, podcast),
      store: true,
      thinkingLevel: "low",
    });
    return interactionId;
  },
  async remember(podcastId, episode, interactionId) {
    if (episode.transcript) await setInteractionIdIfCurrent(podcastId, episode.id, episode.transcript, interactionId);
  },
};

/**
 * Runs `run` with the continuity for this podcast.
 *
 * With interaction context the call continues the interaction of the latest
 * earlier episode. When there isn't a usable one — the episode has none (it was
 * written before the podcast switched, or the ids after a regenerated or deleted
 * episode were forgotten) or the API no longer has it (a stored interaction
 * lives 7 days by default) — the chain is rebuilt with a catch-up call that
 * carries the transcripts as conversation, and its id is saved on that episode
 * so the next call reuses it. The transcripts go in as earlier turns, not in
 * the prompt of the episode being written, so they read as history rather than
 * as a template. If even the catch-up fails, the call is made with the
 * transcripts in its prompt instead of failing.
 */
export async function withContinuity<T>(
  podcast: Podcast,
  prior: PriorEpisode[],
  run: (continuity: Continuity) => Promise<T>,
  deps: ContinuityDeps = defaultContinuityDeps,
): Promise<T> {
  if (!usesInteractionContext(podcast) || prior.length === 0) return run({ previousEpisodes: prior });

  const head = chainHead(prior);
  if (head) {
    try {
      return await run({ previousEpisodes: [], previousInteractionId: head });
    } catch (err) {
      if (!(err instanceof PreviousInteractionNotFoundError)) throw err;
      console.warn(`${err.message}; rebuilding the series state from the transcripts.`);
    }
  }

  let rebuilt: string;
  try {
    rebuilt = await deps.catchUp(podcast, prior);
  } catch (err) {
    console.warn("Catching the series state up failed; sending the transcripts in the prompt instead.", err);
    return run({ previousEpisodes: prior });
  }
  await deps.remember(podcast.id, prior[prior.length - 1]!.episode, rebuilt).catch((err) => {
    console.warn("Could not save the rebuilt series state; it will be rebuilt again next time.", err);
  });
  try {
    return await run({ previousEpisodes: [], previousInteractionId: rebuilt });
  } catch (err) {
    if (!(err instanceof PreviousInteractionNotFoundError)) throw err;
    return run({ previousEpisodes: prior });
  }
}
