import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../config/firebase";
import { deleteEpisodeAudio } from "../storage/audioCache.repository";
import type { Episode, EpisodeCreateInput, EpisodeUpdateInput } from "../schemas/episode.schema";
import type { Person, ResolvedVoiceFields } from "../schemas/person.schema";
import { isStaleEpoch } from "../utils/audioCancellation";
import { NO_VOICE } from "../utils/voiceDecision";
import {
  compareBySeriesOrder,
  selectPriorEpisodes,
  type EpisodeAnchor,
  type PriorEpisode,
} from "../utils/episodeHistory";

function episodesCollection(podcastId: string) {
  return firestore.collection("podcasts").doc(podcastId).collection("episodes");
}

export async function createEpisode(
  podcastId: string,
  input: EpisodeCreateInput,
  // Lines up with `input.guests` by index — see podcast.repository.ts's createPodcast.
  guestVoices: (ResolvedVoiceFields | null)[] = [],
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
    guests: input.guests.map((guest, index) => {
      const { resolvedVoiceId: _clientValue, ...person } = guest;
      return { ...person, id: randomUUID(), ...(guestVoices[index] ?? NO_VOICE) };
    }),
    ...(input.productionNotes ? { productionNotes: input.productionNotes } : {}),
    status: "generating",
    progress: null,
    transcript: null,
    ttsChunks: null,
    generatedAudioSeconds: 0,
    audioComplete: false,
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
  // Lines up with `input.guests` by index — see podcast.repository.ts's updatePodcast.
  guestVoices: (ResolvedVoiceFields | null)[] = [],
): Promise<Episode | null> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  const existing = await ref.get();
  if (!existing.exists) return null;

  // Parsed optional fields can be present-but-undefined, which Firestore
  // rejects — drop them so they mean "leave unchanged". An explicit null
  // (blank production notes, see clearableText) removes the stored field.
  const patch: Record<string, unknown> = Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value === null ? FieldValue.delete() : value]),
  );
  patch.updatedAt = Date.now();
  if (input.guests) {
    const currentGuests = new Map((existing.data() as Episode).guests.map((guest) => [guest.id, guest]));
    patch.guests = input.guests.map((guest, index) => {
      const id = guest.id && currentGuests.has(guest.id) ? guest.id : randomUUID();
      const current = currentGuests.get(id);
      const { resolvedVoiceId: _clientValue, ...person } = guest;
      return {
        ...person,
        id,
        ...(guestVoices[index] ??
          (current
            ? {
                resolvedVoiceId: current.resolvedVoiceId,
                resolvedVoiceOrigin: current.resolvedVoiceOrigin,
                resolvedVoiceHash: current.resolvedVoiceHash,
                ...(current.resolvedVoicePinned !== undefined
                  ? { resolvedVoicePinned: current.resolvedVoicePinned }
                  : {}),
              }
            : NO_VOICE)),
      };
    });
  }

  await ref.update(patch);
  const updated = await ref.get();
  return updated.data() as Episode;
}

/**
 * Forgets the stored voice of every guest whose voice the server designed (not one the user
 * picked): it's a temporary voice that is deleted once the episode's audio is generated, so
 * keeping its id would send the next synthesis to a voice that no longer exists. They are
 * designed again, lazily, the next time audio is generated. Returns the guests as they were.
 */
export async function clearUnpinnedGuestVoices(podcastId: string, episodeId: string): Promise<Person[]> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return [];
    const episode = snap.data() as Episode;
    const cleared = episode.guests.filter((guest) => guest.resolvedVoiceId && !guest.resolvedVoicePinned);
    if (cleared.length === 0) return [];
    const ids = new Set(cleared.map((guest) => guest.id));
    tx.update(ref, {
      guests: episode.guests.map((guest) => (ids.has(guest.id) ? { ...guest, ...NO_VOICE, resolvedVoicePinned: false } : guest)),
      updatedAt: Date.now(),
    });
    return cleared;
  });
}

export async function deleteEpisode(podcastId: string, episodeId: string): Promise<boolean> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  const existing = await ref.get();
  if (!existing.exists) return false;
  await ref.delete();
  await deleteEpisodeAudio(podcastId, episodeId);
  return true;
}

// Filtered in memory (rather than a Firestore range query on createdAt) to
// avoid depending on a manually-provisioned composite index and to keep the
// tiebreak/null-transcript rules in one testable place — fine at this app's
// expected scale of episodes per podcast.
export async function getPriorEpisodes(
  podcastId: string,
  anchor: EpisodeAnchor | undefined,
  limit: number,
): Promise<PriorEpisode[]> {
  const all = (await listEpisodes(podcastId)).sort(compareBySeriesOrder);
  const numberById = new Map(all.map((episode, index) => [episode.id, index + 1]));
  return selectPriorEpisodes(all, anchor, limit).map((episode) => ({
    number: numberById.get(episode.id) ?? 0,
    episode,
  }));
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
 * Persists a guest's freshly-resolved voice onto their entry in the episode
 * doc's `guests` array — called once per generation attempt from
 * orchestrator.ts's runEpisodeGeneration (see
 * voiceResolution.service.ts's resolveGuestVoice, the only caller), so a
 * later `/stream` request can just read it instead of resolving lazily.
 * A transaction, not a plain read-modify-write, purely for consistency with
 * podcast.repository.ts's setHostResolvedVoice — a given episode's guest
 * voice is only ever resolved by one in-flight generation run at a time, so
 * there's no real race to guard against here.
 */
export async function setGuestResolvedVoice(
  podcastId: string,
  episodeId: string,
  guestId: string,
  resolved: { resolvedVoiceId: string; resolvedVoiceOrigin: "design" | "library"; resolvedVoiceHash: string },
): Promise<void> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const episode = snap.data() as Episode;
    const guests = episode.guests.map((guest) => (guest.id === guestId ? { ...guest, ...resolved } : guest));
    tx.update(ref, { guests, updatedAt: Date.now() });
  });
}

/** Stores the Voice Design prompt a guest's voice is about to be designed from — see voiceResolution.service.ts. */
export async function setGuestVoicePrompt(
  podcastId: string,
  episodeId: string,
  guestId: string,
  voicePrompt: string,
): Promise<void> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const episode = snap.data() as Episode;
    const guests = episode.guests.map((guest) => (guest.id === guestId ? { ...guest, voicePrompt } : guest));
    tx.update(ref, { guests, updatedAt: Date.now() });
  });
}

/**
 * Marks an episode's audio as fully generated and records its exact total
 * duration — see the `audioComplete` field on the episode schema.
 */
export async function markAudioComplete(
  podcastId: string,
  episodeId: string,
  durationSeconds: number,
  epoch?: number,
): Promise<void> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    // A generation that began before the audio was cleared must not mark it complete again.
    if (isStaleEpoch(snap.data()?.audioEpoch, epoch)) return;
    const current = (snap.data()?.generatedAudioSeconds as number | undefined) ?? 0;
    tx.update(ref, {
      audioComplete: true,
      audioDurationSeconds: durationSeconds,
      generatedAudioSeconds: Math.max(current, durationSeconds),
      updatedAt: Date.now(),
    });
  });
}

/** The episode's audio epoch (0 if never cleared) — see utils/audioCancellation.ts. */
export async function getAudioEpoch(podcastId: string, episodeId: string): Promise<number> {
  const snap = await episodesCollection(podcastId).doc(episodeId).get();
  return (snap.data()?.audioEpoch as number | undefined) ?? 0;
}

/** Signals every audio generation of the episode, on any instance, to stop. */
export async function bumpAudioEpoch(podcastId: string, episodeId: string): Promise<void> {
  await episodesCollection(podcastId).doc(episodeId).update({ audioEpoch: FieldValue.increment(1) });
}

export async function bumpGeneratedAudioSeconds(
  podcastId: string,
  episodeId: string,
  seconds: number,
  epoch?: number,
): Promise<void> {
  const ref = episodesCollection(podcastId).doc(episodeId);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    if (isStaleEpoch(snap.data()?.audioEpoch, epoch)) return;
    const current = (snap.data()?.generatedAudioSeconds as number | undefined) ?? 0;
    if (seconds > current) {
      tx.update(ref, { generatedAudioSeconds: seconds, updatedAt: Date.now() });
    }
  });
}
