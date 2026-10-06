import type { Request } from "express";
import type { Episode } from "../schemas/episode.schema";
import type { Person } from "../schemas/person.schema";
import type { Podcast } from "../schemas/podcast.schema";
import { hasCurrentVoice } from "./voiceHash";

// Response-only: people are returned with a computed, absolute
// `voicePreviewUrl` pointing at GET /voices/:voiceId/preview, so clients can
// play a person's current voice without building the URL themselves. Never
// stored (a client echoing it back on a save has it stripped by the schemas).
export type WithPreviewUrl<T> = T & { voicePreviewUrl?: string };

// Absolute, so it can go straight into an <audio> tag or ExoPlayer. Behind
// Cloud Run's proxy this relies on `trust proxy` (see app.ts).
export function publicOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

export function voicePreviewUrl(origin: string, voiceId: string): string {
  return `${origin}/voices/${voiceId}/preview`;
}

function withUrl<T extends Person>(origin: string, person: T, previewable: boolean): WithPreviewUrl<T> {
  return previewable && hasCurrentVoice(person)
    ? { ...person, voicePreviewUrl: voicePreviewUrl(origin, person.resolvedVoiceId) }
    : person;
}

/** Hosts whose stored voice is usable (a voice from before the platform move isn't). */
export function presentPodcast(origin: string, podcast: Podcast): WithPreviewUrl<Podcast> & { hosts: WithPreviewUrl<Person>[] } {
  return { ...podcast, hosts: podcast.hosts.map((host) => withUrl(origin, host, true)) };
}

/**
 * Only a guest whose voice the user picked: any other guest's voice is a
 * temporary one deleted once the episode's audio is generated (its id stays
 * on the guest, so a URL for it would usually 404).
 */
export function presentEpisode(origin: string, episode: Episode): Episode & { guests: WithPreviewUrl<Person>[] } {
  return { ...episode, guests: episode.guests.map((guest) => withUrl(origin, guest, !!guest.resolvedVoicePinned)) };
}
