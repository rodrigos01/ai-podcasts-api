import { generateText } from "../../llm/geminiClient";
import {
  buildProducerPromptRequest,
  producerSystemInstruction,
} from "../../llm/prompts/producerPrompt.prompts";
import type { Episode } from "../../schemas/episode.schema";
import type { Podcast } from "../../schemas/podcast.schema";
import {
  producerPromptDraftSchema,
  type ProducerPromptDraft,
  type SpeakerProfile,
} from "../../schemas/producerPrompt.schema";
import type { Speaker } from "./speakerSelection";

/**
 * Renders the structured producer draft into the final base TTS prompt text,
 * following prompting-guide.md's block template extended to 2 speakers
 * (the guide's template is written for a single voice). Rendering
 * deterministically from validated fields — rather than trusting raw LLM
 * prose — keeps this step snapshot-testable.
 */
export function renderProducerPrompt(draft: ProducerPromptDraft): string {
  const profileBlocks = draft.speakerProfiles.map(renderSpeakerProfile).join("\n\n");

  return `# THE SCENE\n${draft.scene}\n\n${profileBlocks}\n\n### SAMPLE CONTEXT\n${draft.sampleContext}`;
}

function renderSpeakerProfile(profile: SpeakerProfile): string {
  return `## AUDIO PROFILE: ${profile.name}\n"${profile.archetype}"\n\n### DIRECTOR'S NOTES for ${profile.name}\nStyle: ${profile.style}\nPacing: ${profile.pacing}\nAccent: ${profile.accent}`;
}

/**
 * Runs before the conversation is generated — see producerPrompt.prompts.ts's
 * system instruction. Deriving this from persona/podcast/episode metadata
 * instead of the finished transcript means it (and the token budget it
 * hands to the chunker) are ready before turn 1, so the pipeline no longer
 * has to wait for the whole conversation before it can start sealing TTS
 * chunks.
 */
export async function generateBaseTtsPrompt(
  podcast: Podcast,
  episode: Episode,
  speakers: [Speaker, Speaker],
): Promise<string> {
  const draft = await generateText({
    systemInstruction: producerSystemInstruction,
    prompt: buildProducerPromptRequest(podcast, episode, speakers),
    schema: producerPromptDraftSchema,
  });
  return renderProducerPrompt(draft);
}
