import { randomUUID } from "node:crypto";
import { LENGTH_RANGES } from "../../constants/lengthRanges";
import { MAX_HISTORY_EPISODES } from "../../constants/episodeHistory";
import { GENERATION_HEARTBEAT_INTERVAL_MS } from "../../constants/generationLease";
import {
  acquireGenerationLease,
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
import { countWords } from "../../utils/wordCount";
import { generateEpisodeScript, type ScriptSeed } from "./scriptGeneration.service";
import { selectCast } from "./speakerSelection";
import { hasCurrentVoice, resolveGuestVoice, resolveHostVoice } from "./voiceResolution.service";
import { chunkTranscript, sealedChunksSoFar } from "./chunker";

interface RunOptions {
  /**
   * Pick up a script a stalled run left behind instead of starting over (see
   * `ensureGenerationRunning`). Without a persisted transcript to continue
   * from this is just a normal fresh run.
   */
  resume?: boolean;
}

/**
 * Generates an episode's script, and starts the next part of its suggestion
 * (if any) once it's done.
 *
 * Runs in-process and detached from any request, so the instance running it
 * can be recycled or throttled at any moment — nothing here may assume it
 * runs to completion. Instead the run holds a short lease on the episode
 * (refreshed while it's alive) and persists its progress as it goes; a stale
 * lease means the run is gone, and `ensureGenerationRunning` resumes the
 * episode from its persisted transcript. If this run is the one that was
 * presumed dead and wakes up after being taken over, its next write fails the
 * lease check and it stops quietly rather than overwrite the new owner's work.
 */
export async function runEpisodeGeneration(
  podcastId: string,
  episodeId: string,
  options: RunOptions = {},
): Promise<void> {
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
    // Read after taking the lease: a stalled run's last write is the last one
    // that can land, so this is exactly what there is to resume from.
    const episode = await getEpisode(podcastId, episodeId);
    if (!episode) throw new Error(`Episode ${episodeId} not found`);

    const seed: ScriptSeed | undefined =
      options.resume && episode.transcript
        ? { transcript: episode.transcript, exposed: (episode.ttsChunks?.length ?? 0) > 0 }
        : undefined;

    if (!seed) {
      // Wipe any previous attempt's transcript/chunks/cached audio before
      // doing anything else. A no-op for a brand-new episode (already in
      // this state), but essential for /regenerate on an already-"ready"
      // episode (episode.controller.ts's regenerate no longer blocks that):
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
        generatedAudioSeconds: 0,
        audioComplete: false,
        audioDurationSeconds: null,
        progress: null,
        error: null,
      });
      await deleteEpisodeAudio(podcastId, episodeId).catch((err) => {
        console.error(
          `Failed to clear cached audio for episode ${podcastId}/${episodeId} before (re)generating:`,
          err,
        );
      });
    }

    const hosts = podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id));
    const guests: Person[] = episode.guests;
    const cast = selectCast(hosts, guests);

    const sources = (
      await Promise.all(episode.sourceIds.map((id) => getSource(podcastId, id)))
    ).filter((s): s is NonNullable<typeof s> => s !== null);

    const wordTarget = LENGTH_RANGES[episode.length];

    // A resumed run is already mid-conversation, with a word count to show.
    const resumedWordCount = seed ? countWords(seed.transcript) : undefined;
    await patch({
      progress: {
        stage: seed ? "conversation" : "kickoff",
        currentWordCount: resumedWordCount ?? 0,
        targetWordRange: wordTarget,
      },
    });

    // Continuity: the transcripts of the episodes that come *before* this one
    // in series order (not merely the newest ones), so regenerating an old
    // episode never sees episodes that were written after it.
    const previousEpisodes = await getPriorEpisodes(
      podcastId,
      { id: episode.id, createdAt: episode.createdAt },
      MAX_HISTORY_EPISODES,
    );

    await patch({
      progress: {
        stage: "conversation",
        ...(resumedWordCount !== undefined ? { currentWordCount: resumedWordCount } : {}),
        targetWordRange: wordTarget,
      },
    });

    // A single LLM call writes the whole episode's script itself — see
    // AGENTS.md's migration note for why this replaced the old per-turn,
    // two-independent-agent conversation loop. Streamed (generateEpisodeScript's
    // onProgress) so the transcript is persisted, and TTS chunks sealed,
    // progressively as turns are confirmed — `sealedChunksSoFar` always
    // withholds the last (possibly still-growing) chunk, and sealing only
    // starts once both cast members have spoken at least once (`canSeal`).
    // Once any chunk has been sealed this way, `status` flips to
    // "streamable" so a listener can start `/stream`-ing before the whole
    // script finishes. That persisted progress is also what a resumed run
    // continues from if this one is lost.
    const scriptPromise = generateEpisodeScript(
      cast,
      { podcast, episode, sources, previousEpisodes },
      wordTarget,
      async ({ transcript, wordCount, canSeal }) => {
        const sealed = canSeal ? sealedChunksSoFar(transcript) : [];
        await patch({
          transcript,
          ...(sealed.length > 0 ? { ttsChunks: sealed, status: "streamable" as const } : {}),
          progress: { stage: "conversation", currentWordCount: wordCount, targetWordRange: wordTarget },
        });
        return sealed.length > 0;
      },
      seed,
    );

    // Voice resolution (host Voice Design cache hit/miss, guest Voice
    // Design/Library mint) runs in parallel with script generation rather
    // than lazily at first `/stream` request — see AGENTS.md and
    // audio.service.ts's resolveCastVoices, which now just reads the ids
    // this persists. A failure here doesn't fail episode generation itself:
    // audio.service.ts still falls back to resolving lazily (and
    // persisting) if a cast member's resolvedVoiceId ends up missing.
    // A resumed run skips guests the stalled run already designed a voice
    // for: guests are re-designed on every fresh attempt (a billed call), but
    // this is the same attempt carrying on.
    const voiceResolutionPromise = Promise.all([
      ...hosts.map((host) => resolveHostVoice(podcastId, host, podcast.languageCode)),
      ...guests
        .filter((guest) => !seed || !hasCurrentVoice(guest))
        .map((guest) => resolveGuestVoice(podcastId, episodeId, guest, podcast.languageCode)),
    ]).catch((err) => {
      console.error(
        `Voice resolution failed for episode ${podcastId}/${episodeId} (will resolve lazily at stream time instead):`,
        err,
      );
    });

    const [script] = await Promise.all([scriptPromise, voiceResolutionPromise]);

    // The true final chunk boundaries — supersedes whatever was sealed
    // progressively above, since sealedChunksSoFar always withheld the
    // true last chunk while generation was still in progress.
    const ttsChunks = chunkTranscript(script.transcript);

    await patch({
      transcript: script.transcript,
      ttsChunks,
      status: "ready",
      progress: { stage: "done", currentWordCount: script.wordCount, targetWordRange: wordTarget },
      error: script.incomplete
        ? "Episode is shorter than targeted — generation couldn't finish after an in-progress recovery"
        : null,
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
 * to a recycled or throttled instance resumes as soon as anyone looks at the
 * episode, from the transcript it had persisted (see `runEpisodeGeneration`).
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
    void runEpisodeGeneration(podcastId, episode.id, { resume: true }).catch((err: unknown) => {
      console.error(`Resumed generation of ${podcastId}/${episode.id} failed:`, err);
    });
  } catch (err) {
    console.error(`Could not check whether ${podcastId}/${episode.id} needs its generation resumed:`, err);
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
