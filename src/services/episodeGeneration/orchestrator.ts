import { randomUUID } from "node:crypto";
import { LENGTH_RANGES } from "../../constants/lengthRanges";
import { MAX_HISTORY_EPISODES } from "../../constants/episodeHistory";
import { GENERATION_HEARTBEAT_INTERVAL_MS } from "../../constants/generationLease";
import {
  acquireGenerationLease,
  clearInteractionIdsAfter,
  getEpisode,
  getPriorEpisodes,
  heartbeatGenerationLease,
  listDependentEpisodes,
  patchEpisodeState,
  patchEpisodeStateAsOwner,
  releaseGenerationLease,
} from "../../data/episode.repository";
import { getPodcast } from "../../data/podcast.repository";
import { getSource } from "../../data/source.repository";
import { deleteEpisodeAudio } from "../../storage/audioCache.repository";
import type { Episode } from "../../schemas/episode.schema";
import type { Person } from "../../schemas/person.schema";
import { dependencyAction, isGenerationSuperseded, needsGenerationRestart } from "../../utils/generationLease";
import { withContinuity } from "./continuity";
import { generateEpisodeScript } from "./scriptGeneration.service";
import { selectCast } from "./speakerSelection";
import { resolveGuestVoice, resolveHostVoice } from "./voiceResolution.service";
import { chunkTranscript } from "./chunker";

/**
 * Generates an episode's script, and starts the next part of its suggestion
 * (if any) once it's done.
 *
 * Runs in-process and detached from any request, so the instance running it
 * can be recycled or throttled at any moment — nothing here may assume it
 * runs to completion. Instead the run holds a short lease on the episode
 * (refreshed while it's alive); a stale lease means the run is gone, and
 * `ensureGenerationRunning` starts the episode over. The script is a single
 * non-streaming call and is only persisted once it's complete, so there is
 * nothing partial to resume from. If this run is the one that was presumed
 * dead and wakes up after being taken over, its next write fails the lease
 * check and it stops quietly rather than overwrite the new owner's work.
 */
export async function runEpisodeGeneration(podcastId: string, episodeId: string): Promise<void> {
  const owner = randomUUID();
  // One run per episode at a time, across instances: whoever loses the race
  // (two polls noticing a stall together, say) leaves the episode to the winner.
  if (!(await acquireGenerationLease(podcastId, episodeId, owner))) return;

  const heartbeat = setInterval(() => {
    heartbeatGenerationLease(podcastId, episodeId, owner).catch((err) => {
      console.error(`Failed to refresh the generation lease for ${podcastId}/${episodeId}:`, err);
    });
  }, GENERATION_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const patch = (fields: Partial<Episode>) => patchEpisodeStateAsOwner(podcastId, episodeId, owner, fields);

  try {
    const podcast = await getPodcast(podcastId);
    if (!podcast) throw new Error(`Podcast ${podcastId} not found`);
    const episode = await getEpisode(podcastId, episodeId);
    if (!episode) throw new Error(`Episode ${episodeId} not found`);

    // Wipe any previous attempt's transcript/chunks/cached audio before
    // doing anything else. A no-op for a brand-new episode (already in
    // this state), but essential for /regenerate on an already-"ready"
    // episode (episode.controller.ts's regenerate no longer blocks that),
    // and for a run restarted after its predecessor was lost:
    // without this, a listener hitting /stream mid-regeneration would
    // still see the *old* transcript and could even become a chunk-
    // generation leader against it — wasting a real synthesis call on
    // content that's about to be discarded. Clearing `transcript` is what
    // actually closes that race, since audio.service.ts's
    // assertAudioAvailable only blocks on a null transcript or
    // status==="failed" — flipping status to "generating" alone wouldn't.
    // Clearing the cached chunk files themselves matters too: a new
    // generation attempt's chunk boundaries/count won't line up with the
    // old ones, so a stale chunk left behind at the same index could get
    // served (or mistaken for "already cached") against all-new content.
    await patch({
      status: "generating",
      transcript: null,
      ttsChunks: null,
      interactionId: null,
      generatedAudioSeconds: 0,
      audioComplete: false,
      audioDurationSeconds: null,
      progress: null,
      error: null,
    });
    // The episodes after this one hold the version being thrown away in their
    // interactions; they'll rebuild from transcripts when next needed.
    await clearInteractionIdsAfter(podcastId, { id: episodeId, createdAt: episode.createdAt });
    await deleteEpisodeAudio(podcastId, episodeId).catch((err) => {
      console.error(
        `Failed to clear cached audio for episode ${podcastId}/${episodeId} before (re)generating:`,
        err,
      );
    });

    const hosts = podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id));
    const guests: Person[] = episode.guests;
    const cast = selectCast(hosts, guests);

    const sources = (
      await Promise.all(episode.sourceIds.map((id) => getSource(podcastId, id)))
    ).filter((s): s is NonNullable<typeof s> => s !== null);

    const wordTarget = LENGTH_RANGES[episode.length];

    await patch({ progress: { stage: "kickoff", currentWordCount: 0, targetWordRange: wordTarget } });

    // Continuity: the episodes that come *before* this one in series order
    // (not merely the newest ones), so regenerating an old episode never sees
    // episodes that were written after it. Their transcripts go in the prompt,
    // or, for a podcast on interaction context, the call continues the previous
    // episode's stored interaction (see continuity.ts).
    const priorEpisodes = await getPriorEpisodes(
      podcastId,
      { id: episode.id, createdAt: episode.createdAt },
      MAX_HISTORY_EPISODES,
    );

    await patch({ progress: { stage: "conversation", currentWordCount: 0, targetWordRange: wordTarget } });

    // A single, non-streaming LLM call writes the whole episode's script
    // itself — see AGENTS.md's migration note for why this replaced the old
    // per-turn, two-independent-agent conversation loop. Nothing is written
    // until the whole script comes back, so a run lost mid-call is simply
    // started over (see ensureGenerationRunning).
    const scriptPromise = withContinuity(podcast, priorEpisodes, ({ previousEpisodes, previousInteractionId }) =>
      generateEpisodeScript(cast, { podcast, episode, sources, previousEpisodes }, wordTarget, previousInteractionId),
    );

    // Voice resolution (host Voice Design cache hit/miss, guest Voice
    // Design/Library mint) runs in parallel with script generation rather
    // than lazily at first `/stream` request — see AGENTS.md and
    // audio.service.ts's resolveCastVoices, which now just reads the ids
    // this persists. A failure here doesn't fail episode generation itself:
    // audio.service.ts still falls back to resolving lazily (and
    // persisting) if a cast member's resolvedVoiceId ends up missing.
    const voiceResolutionPromise = Promise.all([
      ...hosts.map((host) => resolveHostVoice(podcastId, host, podcast.languageCode)),
      ...guests.map((guest) => resolveGuestVoice(podcastId, episodeId, guest, podcast.languageCode)),
    ]).catch((err) => {
      console.error(
        `Voice resolution failed for episode ${podcastId}/${episodeId} (will resolve lazily at stream time instead):`,
        err,
      );
    });

    const [script] = await Promise.all([scriptPromise, voiceResolutionPromise]);

    const ttsChunks = chunkTranscript(script.transcript);

    await patch({
      transcript: script.transcript,
      ttsChunks,
      interactionId: script.interactionId,
      status: "ready",
      progress: { stage: "done", currentWordCount: script.wordCount, targetWordRange: wordTarget },
      error: null,
    });
  } catch (err) {
    if (isGenerationSuperseded(err)) {
      console.log(`Generation of ${podcastId}/${episodeId} was taken over by another run; stopping.`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    try {
      await patch({ status: "failed", error: message });
    } catch (patchErr) {
      // Taken over while failing: the new owner decides how this episode ends.
      if (isGenerationSuperseded(patchErr)) return;
      console.error(`Failed to mark episode ${podcastId}/${episodeId} as failed:`, patchErr);
    }
    await failDependents(podcastId, episodeId, message);
    throw err;
  } finally {
    clearInterval(heartbeat);
    await releaseGenerationLease(podcastId, episodeId, owner).catch((err) => {
      console.error(`Failed to release the generation lease for ${podcastId}/${episodeId}:`, err);
    });
  }

  // Reached only when the script finished: kick off the next part, if any.
  await startDependents(podcastId, episodeId);
}

/**
 * Makes sure an episode that's supposed to be generating actually is. Called
 * wherever someone is waiting on an episode — status polls, `/stream`
 * requests, and a stream's own wait for the next chunk — so a generation lost
 * to a recycled or throttled instance restarts as soon as anyone looks at the
 * episode (see `runEpisodeGeneration`).
 * Cheap when all is well: one check of the episode doc the caller already has.
 *
 * A later part of a multi-episode suggestion waits for the part before it
 * (`startsAfterEpisodeId`): if that one is itself stalled, this wakes it
 * instead, and it starts this one when it finishes.
 *
 * Never rejects — callers fire it and move on.
 */
export async function ensureGenerationRunning(podcastId: string, episode: Episode): Promise<void> {
  try {
    if (!needsGenerationRestart(episode, Date.now())) return;

    if (episode.startsAfterEpisodeId) {
      const predecessor = await getEpisode(podcastId, episode.startsAfterEpisodeId);
      const action = dependencyAction(predecessor);
      if (action === "wait" && predecessor) {
        await ensureGenerationRunning(podcastId, predecessor);
        return;
      }
      if (action === "fail") {
        await patchEpisodeState(podcastId, episode.id, {
          status: "failed",
          error: notGeneratedMessage(predecessor?.error ?? "it failed"),
        });
        return;
      }
    }

    // Not awaited: the caller only needed generation to be underway. The run
    // takes the lease itself, so racing callers produce exactly one generation.
    void runEpisodeGeneration(podcastId, episode.id).catch((err: unknown) => {
      console.error(`Restarted generation of ${podcastId}/${episode.id} failed:`, err);
    });
  } catch (err) {
    console.error(`Could not check whether ${podcastId}/${episode.id} needs its generation restarted:`, err);
  }
}

function notGeneratedMessage(cause: string): string {
  return `Not generated: an earlier part of this multi-episode suggestion failed (${cause})`;
}

/**
 * Starts the part(s) of a multi-episode suggestion that were waiting on this
 * episode. They are created up front (so the confirm request can return every
 * episode at once) but only generate once the part before them is done:
 * part 2 continues from part 1's transcript in its history window, which only
 * exists once part 1 has actually finished. Each part kicking off the next
 * when it ends — rather than one in-process loop over all of them — means a
 * lost instance only ever loses the part it was running, and
 * `ensureGenerationRunning` can pick the chain back up from either end.
 */
async function startDependents(podcastId: string, episodeId: string): Promise<void> {
  try {
    for (const dependent of await listDependentEpisodes(podcastId, episodeId)) {
      await ensureGenerationRunning(podcastId, dependent);
    }
  } catch (err) {
    console.error(`Could not start the episodes that follow ${podcastId}/${episodeId}:`, err);
  }
}

/**
 * If an earlier part fails, the parts after it are marked `"failed"` too
 * rather than left in `"generating"` forever — they depend on its continuity,
 * so generating them anyway would be wrong, and leaving them with no
 * explanation would just look like a hang. `/regenerate` still works on any
 * of them individually afterward.
 */
async function failDependents(podcastId: string, episodeId: string, cause: string): Promise<void> {
  try {
    for (const dependent of await listDependentEpisodes(podcastId, episodeId)) {
      // Only ones still waiting — one with a live run was started on purpose.
      if (!needsGenerationRestart(dependent, Date.now())) continue;
      await patchEpisodeState(podcastId, dependent.id, { status: "failed", error: notGeneratedMessage(cause) });
      await failDependents(podcastId, dependent.id, cause);
    }
  } catch (err) {
    console.error(`Could not mark the episodes that follow ${podcastId}/${episodeId} as failed:`, err);
  }
}
