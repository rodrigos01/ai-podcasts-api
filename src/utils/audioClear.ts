import type { Episode } from "../schemas/episode.schema";
import { HttpError } from "./HttpError";

/**
 * Whether an episode's audio can be cleared right now. Not while the script is still being
 * written (the orchestrator owns the episode's state then), nor while a listener's request
 * is synthesizing a chunk (it would write that chunk back after the delete).
 */
export function assertAudioClearable(status: Episode["status"], chunkBeingGenerated: boolean): void {
  if (status === "generating") {
    throw HttpError.conflict("The episode is still being generated; there is no audio to clear yet.");
  }
  if (chunkBeingGenerated) {
    throw HttpError.conflict("Audio is being generated right now; try again once it has finished.");
  }
}
