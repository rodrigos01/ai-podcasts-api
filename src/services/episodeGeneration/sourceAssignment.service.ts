import { generateText } from "../../llm/geminiClient";
import {
  buildSourceAssignmentRequest,
  sourceAssignmentSystemInstruction,
} from "../../llm/prompts/sourceAssignment.prompts";
import type { Episode } from "../../schemas/episode.schema";
import { sourceAssignmentDraftSchema, type SourceAssignmentDraft } from "../../schemas/sourceAssignment.schema";
import type { Source } from "../../schemas/source.schema";
import type { Speaker } from "./speakerSelection";

/**
 * Turns the model's raw assignment draft into a safe per-speaker source
 * map. Never trust LLM JSON at face value: a hallucinated source id is
 * dropped, an unrecognized speaker id within an otherwise-valid entry is
 * dropped, and — most importantly — any source the model didn't validly
 * assign to *anyone* still has to reach every speaker rather than silently
 * disappearing from the episode's research entirely.
 */
export function normalizeSourceAssignment(
  draft: SourceAssignmentDraft,
  speakers: [Speaker, Speaker],
  sources: Source[],
): Map<string, Source[]> {
  const speakerIds = new Set(speakers.map((s) => s.id));
  const sourcesById = new Map(sources.map((s) => [s.id, s]));
  const result = new Map<string, Source[]>(speakers.map((s) => [s.id, []]));

  const claimed = new Set<string>();
  for (const { sourceId, speakerIds: assignedIds } of draft.assignments) {
    const source = sourcesById.get(sourceId);
    if (!source) continue;
    const validIds = assignedIds.filter((id) => speakerIds.has(id));
    if (validIds.length === 0) continue;
    claimed.add(sourceId);
    for (const id of validIds) {
      result.get(id)?.push(source);
    }
  }

  for (const source of sources) {
    if (!claimed.has(source.id)) {
      for (const speaker of speakers) {
        result.get(speaker.id)?.push(source);
      }
    }
  }

  return result;
}

/**
 * Decides which speaker(s) get which sources for this episode, so agents
 * don't all share identical, complete knowledge of every source — see
 * sourceAssignment.prompts.ts for the rationale. Skips the LLM call
 * entirely for 0 or 1 sources: nothing to assign, or nothing meaningful to
 * split — both fall back to "everyone gets it", the same as pre-assignment
 * behavior.
 */
export async function assignSources(
  speakers: [Speaker, Speaker],
  episode: Episode,
  sources: Source[],
): Promise<Map<string, Source[]>> {
  if (sources.length <= 1) {
    return new Map(speakers.map((s) => [s.id, sources]));
  }

  const draft = await generateText({
    systemInstruction: sourceAssignmentSystemInstruction,
    prompt: buildSourceAssignmentRequest(speakers, episode, sources),
    schema: sourceAssignmentDraftSchema,
  });

  return normalizeSourceAssignment(draft, speakers, sources);
}
