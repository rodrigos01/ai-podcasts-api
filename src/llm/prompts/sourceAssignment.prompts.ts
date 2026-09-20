import type { Episode } from "../../schemas/episode.schema";
import type { Source } from "../../schemas/source.schema";
import type { Speaker } from "../../services/episodeGeneration/speakerSelection";

export const sourceAssignmentSystemInstruction = `You are the producer for this podcast episode, deciding \
research assignments before the conversation is recorded. Real co-hosts and guests don't walk into a \
recording with identical, complete knowledge of every source material someone dug up for the episode — \
each of them would plausibly have read some of it and not the rest, based on their own persona and \
interests. Your job is to decide, for each piece of source material, which speaker(s) would plausibly \
have that material in hand during this conversation.

Guidelines:
- Prefer assigning a source to exactly one speaker over both, based on genuine fit with that speaker's \
persona and interests — don't just split things evenly for its own sake.
- Only assign a source to both speakers if the material is something both would obviously already know \
or have equal reason to have researched.
- Every source must be assigned to at least one speaker — never leave one unassigned.`;

// A short excerpt is enough for this decision — it's a thematic-fit
// judgment against each speaker's persona, not a task that needs the full
// text, and keeping the request small keeps this call fast.
const EXCERPT_LENGTH = 300;

function excerpt(contents: string): string {
  const clipped = contents.slice(0, EXCERPT_LENGTH).replace(/\s+/g, " ").trim();
  return contents.length > EXCERPT_LENGTH ? `${clipped}...` : clipped;
}

export function buildSourceAssignmentRequest(
  speakers: [Speaker, Speaker],
  episode: Episode,
  sources: Source[],
): string {
  const speakerBlocks = speakers
    .map((s) => `- id: "${s.id}", name: ${s.name} (${s.isHost ? "host" : "guest"}), persona: "${s.persona}"`)
    .join("\n");

  const sourceBlocks = sources
    .map((s) => `- id: "${s.id}", title: "${s.title}"\n  excerpt: "${excerpt(s.contents)}"`)
    .join("\n");

  return `Speakers:\n${speakerBlocks}\n\nEpisode topics: ${episode.topics}\nProduction notes: ${episode.productionNotes}\n\nSource material available for this episode:\n${sourceBlocks}\n\nFor each source id above, decide which speaker id(s) should have that material. Return every source id exactly once.`;
}
