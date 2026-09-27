import { randomUUID } from "node:crypto";
import { firestore } from "../config/firebase";
import { deletePodcastAudio } from "../storage/audioCache.repository";
import type { Podcast, PodcastCreateInput, PodcastUpdateInput } from "../schemas/podcast.schema";

const podcastsCollection = firestore.collection("podcasts");

export async function createPodcast(input: PodcastCreateInput, ownerId: string): Promise<Podcast> {
  const id = randomUUID();
  const now = Date.now();
  const podcast: Podcast = {
    id,
    title: input.title,
    description: input.description,
    structure: input.structure,
    hosts: input.hosts.map((host) => ({
      ...host,
      id: randomUUID(),
      resolvedVoiceId: null,
      resolvedVoiceOrigin: null,
      resolvedVoiceHash: null,
    })),
    ownerId,
    createdAt: now,
    updatedAt: now,
  };
  await podcastsCollection.doc(id).set(podcast);
  return podcast;
}

export async function getPodcast(podcastId: string): Promise<Podcast | null> {
  const snap = await podcastsCollection.doc(podcastId).get();
  return snap.exists ? (snap.data() as Podcast) : null;
}

// Filtered in memory rather than a Firestore `where(ownerId==) + orderBy`
// compound query, to avoid depending on a manually-provisioned composite
// index — same reasoning as getRecentCondensedSummariesForHost, fine at
// this app's expected scale (podcasts per user).
export async function listPodcasts(ownerId: string): Promise<Podcast[]> {
  const snap = await podcastsCollection.orderBy("createdAt", "desc").get();
  return snap.docs
    .map((doc) => doc.data() as Podcast)
    .filter((podcast) => podcast.ownerId === ownerId);
}

export async function updatePodcast(
  podcastId: string,
  input: PodcastUpdateInput,
): Promise<Podcast | null> {
  const ref = podcastsCollection.doc(podcastId);
  const existing = await ref.get();
  if (!existing.exists) return null;

  const patch: Record<string, unknown> = { ...input, updatedAt: Date.now() };
  if (input.hosts) {
    const currentHosts = new Map((existing.data() as Podcast).hosts.map((host) => [host.id, host]));
    patch.hosts = input.hosts.map((host) => {
      const id = host.id && currentHosts.has(host.id) ? host.id : randomUUID();
      // A matched existing host keeps its already-resolved voice — an edit
      // to persona/accent/voice hint doesn't need to be caught here;
      // voiceResolution.service.ts's resolveHostVoice hashes those fields
      // itself and re-designs lazily, at the next episode generation, if
      // they've changed. A genuinely new host (no matching id) starts
      // unresolved, same as at podcast creation.
      const current = currentHosts.get(id);
      return {
        ...host,
        id,
        resolvedVoiceId: current?.resolvedVoiceId ?? null,
        resolvedVoiceOrigin: current?.resolvedVoiceOrigin ?? null,
        resolvedVoiceHash: current?.resolvedVoiceHash ?? null,
      };
    });
  }

  await ref.update(patch);
  const updated = await ref.get();
  return updated.data() as Podcast;
}

/**
 * Persists a host's freshly-resolved Voice Design voice so every future
 * episode of this podcast reuses it instead of re-designing (see
 * services/episodeGeneration/voiceResolution.service.ts's resolveHostVoice,
 * the only caller). A transaction, not a plain read-modify-write, since two
 * concurrent first-time episode generations for the same new host could
 * otherwise race and each write their own separately-designed voice, with
 * the loser's overwritten silently.
 */
export async function setHostResolvedVoice(
  podcastId: string,
  hostId: string,
  resolved: { resolvedVoiceId: string; resolvedVoiceOrigin: "design"; resolvedVoiceHash: string },
): Promise<void> {
  const ref = podcastsCollection.doc(podcastId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const podcast = snap.data() as Podcast;
    const hosts = podcast.hosts.map((host) => (host.id === hostId ? { ...host, ...resolved } : host));
    tx.update(ref, { hosts, updatedAt: Date.now() });
  });
}

export async function deletePodcast(podcastId: string): Promise<boolean> {
  const ref = podcastsCollection.doc(podcastId);
  const existing = await ref.get();
  if (!existing.exists) return false;

  await firestore.recursiveDelete(ref);
  await deletePodcastAudio(podcastId);
  return true;
}
