import { randomUUID } from "node:crypto";
import { firestore } from "../config/firebase";
import { deleteEpisodeAudio } from "../storage/audioCache.repository";
import type { Episode, EpisodeCreateInput, EpisodeUpdateInput } from "../schemas/episode.schema";

function episodesCollection(podcastId: string) {
  return firestore.collection("podcasts").doc(podcastId).collection("episodes");
}

export async function createEpisode(
  podcastId: string,
  input: EpisodeCreateInput,
): Promise<Episode> {
  const id = randomUUID();
  const now = Date.now();
  const episode: Episode = {
    id,
    title: input.title,
    topics: input.topics,
    length: input.length,
    sourceIds: input.sourceIds,
    participantHostIds: input.participantHostIds,
    guests: input.guests.map((guest) => ({
      ...guest,
      id: randomUUID(),
      resolvedVoiceId: null,
      resolvedVoiceOrigin: null,
      resolvedVoiceHash: null,
    })),
    productionNotes: input.productionNotes,
    status: "generating",
    progress: null,
    transcript: null,
    generatedAudioSeconds: 0,
    condensedSummaries: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await episodesCollection(podcastId).doc(id).set(episode);
  return episode;
}

export async function getEpisode(podcastId: string, episodeId: string): Promise<Episode | null> {
  const snap = await episodesCollection(podcastId).doc(episodeId).get();
  return snap.exists ? (snap.data() as Episode) : null;
}

export async function listEpisodes(podcastId: string): Promise<Episode[]> {
  const snap = await episodesCollection(podcastId).orderBy("createdAt", "desc").get();
  return snap.docs.map((doc) => doc.data() as Episode);
}

export async function updateEpisode(
  podcastId: string,
  episodeId: string,
  input: EpisodeUpdateInput,
): Promise<Episode | null> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  const existing = await ref.get();
  if (!existing.exists) return null;

  await ref.update({ ...input, updatedAt: Date.now() });
  const updated = await ref.get();
  return updated.data() as Episode;
}

export async function deleteEpisode(podcastId: string, episodeId: string): Promise<boolean> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  const existing = await ref.get();
  if (!existing.exists) return false;
  await ref.delete();
  await deleteEpisodeAudio(podcastId, episodeId);
  return true;
}

export async function getRecentCondensedSummariesForHost(
  podcastId: string,
  hostId: string,
  excludeEpisodeId: string,
  limit = 5,
): Promise<string[]> {
  // Filtered in memory (rather than a Firestore array-contains + orderBy
  // compound query) to avoid depending on a manually-provisioned composite
  // index — fine at this app's expected scale of episodes per podcast.
  const episodes = await listEpisodes(podcastId);
  return episodes
    .filter(
      (episode) =>
        episode.id !== excludeEpisodeId &&
        episode.status === "ready" &&
        episode.participantHostIds.includes(hostId),
    )
    .slice(0, limit)
    .map((episode) => episode.condensedSummaries?.[hostId])
    .filter((summary): summary is string => Boolean(summary));
}

export async function patchEpisodeState(
  podcastId: string,
  episodeId: string,
  patch: Partial<Episode>,
): Promise<void> {
  await episodesCollection(podcastId).doc(episodeId).update({ ...patch, updatedAt: Date.now() });
}

/**
 * Advances `generatedAudioSeconds` to `seconds`, but never backward. Chunk
 * generation is causally ordered (a chunk is never generated until the one
 * before it is already cached — see audio.service.ts's streamEpisodeAudio),
 * so out-of-order writes shouldn't happen in practice; the transaction is a
 * cheap guarantee against it anyway (e.g. a delayed retry landing after a
 * later chunk's write) rather than a load-bearing assumption.
 */
/**
 * Resolves an episode's guest voice exactly once, deduplicated across
 * concurrent first-time listeners/instances (a guest is always
 * episode-scoped — see voiceResolution.service.ts's resolveGuestVoice, the
 * only caller of `resolve` below). If the guest already has a resolved
 * voice, returns it immediately with no work done. Otherwise runs the
 * (slow, billed) `resolve` callback outside any transaction, then commits
 * it via a transaction that re-checks first — if another caller won the
 * race in the meantime, this discards its own result via `cleanup` (a
 * losing Voice-Design mint would otherwise leak as an orphaned,
 * quota-counted voice) and returns the winner's instead.
 */
export async function resolveAndPersistGuestVoice(
  podcastId: string,
  episodeId: string,
  guestId: string,
  resolve: () => Promise<{ voiceId: string; origin: "design" | "library" }>,
  cleanup: (voiceId: string) => Promise<void>,
): Promise<{ voiceId: string; origin: "design" | "library" }> {
  const ref = episodesCollection(podcastId).doc(episodeId);

  function alreadyResolved(
    episode: Episode | null | undefined,
  ): { voiceId: string; origin: "design" | "library" } | null {
    const guest = episode?.guests.find((g) => g.id === guestId);
    if (guest?.resolvedVoiceId && guest.resolvedVoiceOrigin) {
      return { voiceId: guest.resolvedVoiceId, origin: guest.resolvedVoiceOrigin };
    }
    return null;
  }

  const existing = alreadyResolved(await getEpisode(podcastId, episodeId));
  if (existing) return existing;

  const resolved = await resolve();
  const outcome = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const episode = snap.exists ? (snap.data() as Episode) : undefined;
    const winner = alreadyResolved(episode);
    if (winner) return { ...winner, won: false as const };

    const guests = (episode?.guests ?? []).map((guest) =>
      guest.id === guestId
        ? { ...guest, resolvedVoiceId: resolved.voiceId, resolvedVoiceOrigin: resolved.origin }
        : guest,
    );
    tx.update(ref, { guests, updatedAt: Date.now() });
    return { ...resolved, won: true as const };
  });

  if (!outcome.won && resolved.origin === "design") {
    await cleanup(resolved.voiceId);
  }
  return { voiceId: outcome.voiceId, origin: outcome.origin };
}

export async function bumpGeneratedAudioSeconds(
  podcastId: string,
  episodeId: string,
  seconds: number,
): Promise<void> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const current = (snap.data()?.generatedAudioSeconds as number | undefined) ?? 0;
    if (seconds > current) {
      tx.update(ref, { generatedAudioSeconds: seconds, updatedAt: Date.now() });
    }
  });
}
