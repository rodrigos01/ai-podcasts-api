import type { Episode } from "../schemas/episode.schema";

/**
 * The episode fields a (re)generation starts from: nothing generated yet.
 * Used by the orchestrator's own wipe and by the admin's bulk regenerate, which
 * resets every queued episode up front, so anything a generation writes must
 * be reset here (`interactionId` in particular: a stored chain that still held
 * the old version would be continued from).
 */
export const CLEAN_GENERATION_STATE: Partial<Episode> = {
  status: "generating",
  transcript: null,
  ttsChunks: null,
  interactionId: null,
  generatedAudioSeconds: 0,
  audioComplete: false,
  audioDurationSeconds: null,
  progress: null,
  error: null,
};
