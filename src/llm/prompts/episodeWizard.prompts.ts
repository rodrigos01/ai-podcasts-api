import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import { VOICES } from "../../constants/voices";
import { LENGTH_RANGES, type EpisodeLength } from "../../constants/lengthRanges";

const voiceCatalog = VOICES.map((v) => `${v.id} (${v.gender}, ${v.trait})`).join(", ");

// Built from LENGTH_RANGES (the same source of truth episode confirmation
// itself validates against) so the model reasons about concrete word
// counts, not just the bare words "short"/"medium"/"long".
const lengthCatalog = (Object.keys(LENGTH_RANGES) as EpisodeLength[])
  .map((length) => `${length} (${LENGTH_RANGES[length].min}-${LENGTH_RANGES[length].max} words)`)
  .join(", ");

export function episodeWizardSystemInstruction(podcast: Podcast): string {
  return `You are the producer for the podcast "${podcast.title}".

Podcast description: ${podcast.description}

Podcast structure:
${podcast.structure}

Fixed hosts on this show, with their assigned voices: ${podcast.hosts.map((h) => `${h.name} (persona: ${h.persona}; voice: ${h.voice})`).join("; ")}

Given pre-production source material and an optional user prompt for a specific episode, you draft that \
episode's title, topics, production notes (directional guidance for how the hosts should run this \
episode, referencing the show's structure), and — if this episode calls for one — a single guest \
character with a life-like persona relevant to the topics. Not every episode needs a guest; only include \
one if it clearly fits.

If you include a guest, their "voice" field must be exactly one of these IDs (pick the best natural \
gender/trait match for the persona): ${voiceCatalog}. Never assign the guest a voice ID already used by \
one of this show's fixed hosts listed above — every speaker who might appear together in an episode needs \
a distinct voice so listeners can tell them apart.

Also suggest a "suggestedLength", one of: ${lengthCatalog}. Base it on how much there genuinely is to \
cover — the depth and breadth of the source material and topics, not a default or a guess — since this is \
only ever a pre-selected starting point the user can still change, not a binding decision.`;
}

function sourceBlock(sources: Source[]): string {
  if (sources.length === 0) return "(no source material provided)";
  return sources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n");
}

export function buildEpisodeDraftPrompt(sources: Source[], prompt?: string): string {
  const promptBlock = prompt ? `\n\nUser's prompt for this episode: "${prompt}"` : "";
  return `Pre-production source material for this episode:\n\n${sourceBlock(sources)}${promptBlock}

Draft this episode. Return exactly 3 "predictedChanges" — plausible follow-up edits the user might want \
(e.g. "Add a guest", "Narrow the topics to just X", "Make the production notes more casual").`;
}

export function buildEpisodeRevisePrompt(currentDraft: unknown, instruction: string): string {
  return `Here is the current episode draft:\n${JSON.stringify(currentDraft)}

The user's revision instruction: "${instruction}"

Regenerate the draft, applying the instruction. Keep whatever the instruction doesn't ask to change, \
including "suggestedLength" — unless the instruction itself changes how much there is to cover (e.g. \
narrowing or expanding the topics), in which case reconsider it too. Return exactly 3 new \
"predictedChanges" appropriate to the revised draft.`;
}
