import type { Episode, EpisodeUpdateInput } from "../schemas/episode.schema";
import type { Person } from "../schemas/person.schema";
import type { EpisodeRedraft } from "../services/episodeWizard.service";
import { withVoicePrompt } from "./voicePrompt";

/**
 * What storing a redraft changes on the episode, and the guests it replaced
 * (whose voices need cleaning up). The cast size is fixed (the 2-voice rule),
 * so a redraft whose guest count doesn't match the episode's keeps the
 * existing guests instead of changing it. A new guest has no id, so the
 * repository stores it as a new person with no voice (designed at generation).
 */
export function redraftToUpdate(
  episode: Pick<Episode, "guests">,
  draft: EpisodeRedraft,
): { update: EpisodeUpdateInput; replacedGuests: Person[] } {
  const replaceGuests = draft.guests.length === episode.guests.length && draft.guests.length > 0;
  return {
    update: {
      title: draft.title,
      topics: draft.topics,
      // null removes the stored notes: a redraft that sets none means none.
      productionNotes: draft.productionNotes ?? null,
      ...(replaceGuests ? { guests: draft.guests.map(withVoicePrompt) } : {}),
    },
    replacedGuests: replaceGuests ? episode.guests : [],
  };
}
