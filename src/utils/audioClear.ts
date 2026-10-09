import type { Episode } from "../schemas/episode.schema";
import { HttpError } from "./HttpError";

/**
 * Whether an episode's audio can be cleared right now. Not while the script is still being
 * written (the orchestrator owns the episode's state then). Audio being synthesized is no
 * obstacle: clearing cancels it (see services/audioClear.service.ts).
 */
export function assertAudioClearable(status: Episode["status"]): void {
  if (status === "generating") {
    throw HttpError.conflict("The episode is still being generated; there is no audio to clear yet.");
  }
}
