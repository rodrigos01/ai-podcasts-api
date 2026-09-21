import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import { VOICES } from "../../constants/voices";
import { LENGTH_RANGES, type EpisodeLength } from "../../constants/lengthRanges";
import type { EpisodeSuggestion } from "../../schemas/wizard.schema";

const voiceCatalog = VOICES.map((v) => `${v.id} (${v.gender}, ${v.trait})`).join(", ");

// Built from LENGTH_RANGES (the same source of truth episode confirmation
// itself validates against) so the model reasons about concrete word
// counts, not just the bare words "short"/"medium"/"long".
const lengthCatalog = (Object.keys(LENGTH_RANGES) as EpisodeLength[])
  .map((length) => `${length} (${LENGTH_RANGES[length].min}-${LENGTH_RANGES[length].max} words)`)
  .join(", ");

export function episodeWizardSystemInstruction(podcast: Podcast, length: EpisodeLength): string {
  const targetRange = LENGTH_RANGES[length];

  return `You are the producer for the podcast "${podcast.title}".

Podcast description: ${podcast.description}

Podcast structure:
${podcast.structure}

Fixed hosts on this show, with their assigned voices: ${podcast.hosts.map((h) => `${h.name} (persona: ${h.persona}; voice: ${h.voice})`).join("; ")}

The user has already chosen a target episode length of "${length}" (${targetRange.min}-${targetRange.max} \
spoken words, roughly matching the studio's length options: ${lengthCatalog}) before you draft anything — \
this is a fixed constraint, not something you suggest.

Given pre-production source material and an optional user prompt for a specific episode, you draft that \
episode's title, topics, production notes (directional guidance for how the hosts should run this \
episode, referencing the show's structure), and — if this episode calls for one — a single guest \
character with a life-like persona relevant to the topics. Not every episode needs a guest; only include \
one if it clearly fits.

If you include a guest, their "voice" field must be exactly one of these IDs (pick the best natural \
gender/trait match for the persona): ${voiceCatalog}. Never assign the guest a voice ID already used by \
one of this show's fixed hosts listed above — every speaker who might appear together in an episode needs \
a distinct voice so listeners can tell them apart.

You return an array of "suggestions". Always include exactly one suggestion containing your single best \
episode draft, written to fit within the ${length} target as well as it genuinely can. Only if the source \
material and topics are truly too broad or deep to do justice to within that target — not merely "could \
say more", but a genuine mismatch of scope — also include a second suggestion containing a natural \
2-episode split: two drafts, each with its own title/topics/production notes/guest, dividing the material \
into a sensible "Part 1" and "Part 2" (name them accordingly in their titles) that could each individually \
fit the ${length} target. If a single episode can cover the material well, do not include a second \
suggestion at all — most drafts should NOT need one; use it sparingly, only for a genuine mismatch. When \
you do split, keep the same guest across both parts unless the material genuinely calls for a different \
one, and make each part's production notes aware it's one half of a two-part episode (e.g. what the other \
part covers) so the eventual recording reads as a coherent pair, not two unrelated episodes.`;
}

function sourceBlock(sources: Source[]): string {
  if (sources.length === 0) return "(no source material provided)";
  return sources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n");
}

export function buildEpisodeDraftPrompt(sources: Source[], prompt?: string): string {
  const promptBlock = prompt ? `\n\nUser's prompt for this episode: "${prompt}"` : "";
  return `Pre-production source material for this episode:\n\n${sourceBlock(sources)}${promptBlock}

Draft this episode (or, if warranted, this episode plus a 2-part split alternative — see the rules above). \
For every draft, return exactly 3 "predictedChanges" — plausible follow-up edits the user might want (e.g. \
"Add a guest", "Narrow the topics to just X", "Make the production notes more casual").`;
}

export function buildEpisodeRevisePrompt(
  suggestions: EpisodeSuggestion[],
  targetSuggestionIndex: number,
  targetEpisodeIndex: number | undefined,
  instruction: string,
): string {
  const scopeLine =
    targetEpisodeIndex === undefined
      ? `every episode draft within suggestion index ${targetSuggestionIndex}`
      : `only episode index ${targetEpisodeIndex} within suggestion index ${targetSuggestionIndex} \
(leave the other episode in that suggestion, if any, unchanged)`;

  return `Here are the current suggestions:\n${JSON.stringify(suggestions)}

The user's revision instruction: "${instruction}"

Apply the instruction to ${scopeLine}. Keep whatever the instruction doesn't ask to change. Return the \
full suggestions array again in the same shape (1 suggestion, or 2 if a split is present/warranted — \
reconsider whether a split is still appropriate if the instruction changes how much there is to cover, \
e.g. narrowing or expanding the topics). Return exactly 3 new "predictedChanges" for every draft you \
return, appropriate to its revised content.`;
}
