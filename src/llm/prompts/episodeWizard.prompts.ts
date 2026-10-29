import type { PriorEpisode } from "../../utils/episodeHistory";
import type { Podcast } from "../../schemas/podcast.schema";
import type { Source } from "../../schemas/source.schema";
import type { Episode } from "../../schemas/episode.schema";
import { LENGTH_RANGES, type EpisodeLength } from "../../constants/lengthRanges";
import type { EpisodeSuggestion } from "../../schemas/wizard.schema";
import { buildChainedHistoryNote, buildEpisodeHistoryBlock } from "./episodeHistory.prompts";

// Built from LENGTH_RANGES (the same source of truth episode confirmation
// itself validates against) so the model reasons about concrete word
// counts, not just the bare words "short"/"medium"/"long".
const lengthCatalog = (Object.keys(LENGTH_RANGES) as EpisodeLength[])
  .map((length) => `${length} (${LENGTH_RANGES[length].min}-${LENGTH_RANGES[length].max} words)`)
  .join(", ");

// The rules for the fields of an episode draft (guest, accent, topics, production
// notes), shared by drafting a new episode and redrafting an existing one.
const DRAFT_FIELD_GUIDANCE = `If you include a guest, their "voice" field is a short, free-text description of how they should sound — \
age, tone, gender, pacing, energy — the same kind of description a fixed host has (see above), not a pick \
from a fixed list. The voice itself is designed later from the persona (and accent), so the persona must \
say enough about the guest to imply how they sound. Make them clearly distinguishable from every fixed host's listed above — every speaker who might appear \
together in an episode needs to sound distinct so listeners can tell them apart.

Only when the guest's persona specifically calls for a distinctive spoken accent (regional, national, or \
non-native) may you also set their "accent" field — a short description of the accent, written in \
the same language as the persona and the rest of the show (e.g. "Northern Irish" or "light French accent" for \
an English show, "sotaque nordestino" for a Portuguese one), the same optional field a fixed host may have (see above). Leave it unset \
for an ordinary/neutral voice — but if the guest's voice description mentions an accent, set it.

Keep the draft short and high-level. It is an outline a script writer will use to structure the \
transcript, not a prescription of it: "topics" is a brief list or sentence of the subjects and angles to \
cover. Never script what the hosts or guest should say, react to, joke about or come up with, and don't \
dictate specific lines, anecdotes, opinions or beat-by-beat sequencing — leave that to the script writer. \
Don't include time markers or durations.

"productionNotes" is optional, and you should leave it out by default — don't use it to suggest angles, \
tone, structure or callbacks; the sources, topics and the show's own structure already carry that. Only \
set it when there is something specific the hosts should focus or pay attention to that cannot be \
inferred from the sources and topics alone — for example, notes the user supplied themselves in their \
prompt or revision instructions (carry those through faithfully, tightened if needed), or the part-to-part \
context of a 2-episode split (see below), which is always a valid use. When revising, keep \
existing production notes the instruction doesn't touch, and don't add new ones on your own (other than split context, if a revision turns an episode into a 2-part split).`;

export function episodeWizardSystemInstruction(
  podcast: Podcast,
  length: EpisodeLength,
  previousEpisodes: PriorEpisode[],
  // The call continues the series' stored interaction: the earlier episodes
  // are in the conversation, not in `previousEpisodes` (see continuity.ts).
  chained = false,
): string {
  const targetRange = LENGTH_RANGES[length];
  const history = chained ? buildChainedHistoryNote() : buildEpisodeHistoryBlock(previousEpisodes, podcast);
  const historySection = history
    ? `\n\n${history}\n\nWhen drafting, keep this history in mind: build on it rather than repeating it, and \
build on it in the topics where a callback or follow-up would help (a guest appearing again is fine \
when it fits, but don't reuse a past guest just because they existed).`
    : "";

  return `You are the producer for the podcast "${podcast.title}".

Podcast description: ${podcast.description}

Podcast structure:
${podcast.structure}

Fixed hosts on this show, with their voice descriptions: ${podcast.hosts.map((h) => `${h.name} (persona: ${h.persona}; voice: ${h.voice}${h.accent ? `; accent: ${h.accent}` : ""})`).join("; ")}${historySection}

The user has already chosen a target episode length of "${length}" (${targetRange.min}-${targetRange.max} \
spoken words, roughly matching the studio's length options: ${lengthCatalog}) before you draft anything — \
this is a fixed constraint, not something you suggest.

Given pre-production source material and an optional user prompt for a specific episode, you draft that \
episode's title, topics, optionally production notes, and — if this episode calls for one — a single guest \
character with a life-like persona relevant to the topics. Not every episode needs a guest; only include \
one if it clearly fits.

${DRAFT_FIELD_GUIDANCE}

You return an array of 1 or 2 "suggestions". There is no fixed pattern of which suggestion has how many \
episodes — decide each suggestion's shape independently, on its own merits.

Always include at least one suggestion: your best plan for this request. That's usually a single episode \
written to fit within the ${length} target as well as it genuinely can — but make it a natural 2-episode \
split instead when a split is clearly the right call: either because the user's own prompt explicitly \
asked for the material to be split into multiple episodes, or because the material and topics are \
genuinely too broad or deep to do justice to within the ${length} target as one episode (not merely "could \
say more", but a real mismatch of scope). A lone suggestion is just as free to be a split as a single \
episode — don't force a single-episode option into existence when a split is what's actually called for.

Only include a second suggestion when there's a genuinely useful alternative worth offering side by side \
with the first — e.g. a tight single episode versus a fuller two-part treatment. Most requests don't need \
a second suggestion at all; use it sparingly, and never just to pad the array out to 2. The second \
suggestion, when you do include one, does not need to differ in episode count from the first.

Whenever any suggestion contains a 2-episode split: give each part its own title/topics/guest, dividing the material into a sensible "Part 1" and "Part 2" (name them accordingly in their \
titles) that could each individually fit the ${length} target; keep the same guest across both parts \
unless the material genuinely calls for a different one; and give each part production notes making it aware it's \
one half of a two-part episode (e.g. what the other part covers) so the eventual recording reads as a \
coherent pair, not two unrelated episodes.`;
}

function sourceBlock(sources: Source[]): string {
  if (sources.length === 0) return "(no source material provided)";
  return sources.map((s) => `### ${s.title}\n${s.contents}`).join("\n\n");
}

export function buildEpisodeDraftPrompt(sources: Source[], prompt?: string): string {
  const promptBlock = prompt ? `\n\nUser's prompt for this episode: "${prompt}"` : "";
  return `Pre-production source material for this episode:\n\n${sourceBlock(sources)}${promptBlock}

Draft your suggestion(s) for this episode request — see the rules above for when a suggestion should be a \
single episode vs. a split, and when a second alternative suggestion is worth including. For every draft, \
return exactly 3 "predictedChanges" — plausible follow-up edits the user might want (e.g. "Add a guest", \
"Narrow the topics to just X", "Make the tone more casual").`;
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
full suggestions array again — 1 or 2 suggestions, each independently a single episode or a split, \
whichever is right for it (no fixed pattern of which entry has how many episodes); reconsider whether the \
suggestion(s) you're revising should switch between single-episode and split if the instruction changes \
how much there is to cover, e.g. narrowing or expanding the topics, or explicitly asking for a split. \
Return exactly 3 new "predictedChanges" for every draft you return, appropriate to its revised content.`;
}

function hostLine(podcast: Podcast): string {
  return podcast.hosts
    .map((h) => `${h.name} (persona: ${h.persona}; voice: ${h.voice}${h.accent ? `; accent: ${h.accent}` : ""})`)
    .join("; ");
}

/**
 * System instruction for redrafting ONE existing episode (an admin's bulk
 * regenerate with "re-draft"): the same producer and field rules as the
 * wizard, but the result is a single episode with the same length and cast
 * size, never a suggestion array or a split.
 */
export function episodeRedraftSystemInstruction(
  podcast: Podcast,
  episode: Episode,
  previousEpisodes: PriorEpisode[],
  // The call continues the series' stored interaction: the earlier episodes
  // are in the conversation, not in `previousEpisodes` (see continuity.ts).
  chained = false,
): string {
  const targetRange = LENGTH_RANGES[episode.length];
  const history = chained ? buildChainedHistoryNote() : buildEpisodeHistoryBlock(previousEpisodes, podcast);
  const historySection = history
    ? `\n\n${history}\n\nWhen drafting, keep this history in mind: build on it rather than repeating it, and \
build on it in the topics where a callback or follow-up would help (a guest appearing again is fine \
when it fits, but don't reuse a past guest just because they existed).`
    : "";
  const castRule =
    episode.guests.length === 0
      ? "This episode has no guest: its two voices are both fixed hosts. Do not add a guest (return an empty \"guests\" array)."
      : "This episode has exactly one guest alongside a fixed host. Draft one guest (the \"guests\" array must have exactly one entry).";

  return `You are the producer for the podcast "${podcast.title}".

Podcast description: ${podcast.description}

Podcast structure:
${podcast.structure}

Fixed hosts on this show, with their voice descriptions: ${hostLine(podcast)}${historySection}

You are redrafting one existing episode of this show from scratch: a fresh take on its title, topics, \
optional production notes and guest. The episode's target length is fixed at "${episode.length}" \
(${targetRange.min}-${targetRange.max} spoken words) and its cast size is fixed. ${castRule}

You are given the episode's source material and its current draft. Keep its role in the series: if the \
current draft is one part of a two-part episode (its title or production notes say so), it must stay that part \
and keep covering what the notes say it covers. Otherwise, you may find different angles in the sources than the \
current draft chose, a new title, and a different guest. Return exactly one episode draft — never a split.

${DRAFT_FIELD_GUIDANCE}`;
}

export function buildEpisodeRedraftPrompt(episode: Episode, sources: Source[]): string {
  const guest = episode.guests[0];
  return `Pre-production source material for this episode:

${sourceBlock(sources)}

Current draft of this episode (to be redrafted):
Title: ${episode.title}
Topics: ${episode.topics}
Production notes: ${episode.productionNotes ?? "(none)"}
Guest: ${guest ? `${guest.name} (persona: ${guest.persona}${guest.accent ? `; accent: ${guest.accent}` : ""})` : "(none)"}

Redraft this episode.`;
}
