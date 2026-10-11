/** The unauthenticated, stable URL for an episode's audio (see app.ts). */
export function episodeAudioUrl(origin: string, podcastId: string, episodeId: string): string {
  return `${origin}/podcasts/${podcastId}/episodes/${episodeId}/audio`;
}
