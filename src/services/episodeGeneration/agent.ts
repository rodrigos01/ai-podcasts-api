import { generatePlainText } from "../../llm/geminiClient";
import {
  buildAgentSystemInstruction,
  buildKickoffTurnPrompt,
  buildResponseTurnPrompt,
  END_EPISODE_MARKER,
  type AgentContext,
} from "../../llm/prompts/hostPersona.prompts";
import type { Speaker } from "./speakerSelection";

export interface AgentTurn {
  speech: string;
  endEpisode: boolean;
}

/**
 * A turn's own text must never contain a blank-line paragraph break —
 * transcriptBuilder.ts joins turns with "\n\n", and every downstream
 * consumer (chunker.ts, scriptText.ts's parseScriptTurns) re-splits the
 * transcript on that exact separator to find turn boundaries. If a single
 * turn's text had an internal "\n\n" whose next paragraph happened to start
 * with something shaped like "Word:" (a plausible way to open a sentence —
 * "Watch this: ..."), it would be misread as a brand new speaker label,
 * scrambling voice attribution. The prompt asks the model not to do this,
 * but instructions aren't guarantees — collapsing internal paragraph
 * breaks here makes the invariant hold regardless of compliance.
 */
function sanitizeSpeech(text: string): string {
  return text.replace(/\n{2,}/g, " ").trim();
}

/**
 * `rawText` is plain dialogue, optionally followed by a trailing
 * END_EPISODE_MARKER line (see hostPersona.prompts.ts). Not a zod schema
 * anymore — there's no JSON to validate, just a marker to strip.
 */
export function parseAgentTurn(rawText: string): AgentTurn {
  const markerIndex = rawText.lastIndexOf(END_EPISODE_MARKER);
  const endEpisode = markerIndex !== -1;
  const speech = sanitizeSpeech(endEpisode ? rawText.slice(0, markerIndex) : rawText);
  if (!speech) {
    throw new Error("Gemini returned an empty turn");
  }
  return { speech, endEpisode };
}

export class AgentSession {
  private readonly systemInstruction: string;

  constructor(
    private readonly speaker: Speaker,
    context: AgentContext,
  ) {
    this.systemInstruction = buildAgentSystemInstruction(speaker, context);
  }

  async kickoff(wordTarget: { min: number; max: number }): Promise<AgentTurn> {
    const text = await generatePlainText({
      systemInstruction: this.systemInstruction,
      prompt: buildKickoffTurnPrompt(wordTarget),
    });
    // The kickoff prompt never offers the end-episode marker (opening turn
    // can't end the episode) — no marker-stripping needed.
    const speech = sanitizeSpeech(text);
    if (!speech) throw new Error("Gemini returned an empty turn");
    return { speech, endEpisode: false };
  }

  async respond(
    transcriptSoFar: string,
    currentWordCount: number,
    wordTarget: { min: number; max: number },
  ): Promise<AgentTurn> {
    const text = await generatePlainText({
      systemInstruction: this.systemInstruction,
      prompt: buildResponseTurnPrompt(transcriptSoFar, currentWordCount, wordTarget),
    });
    return parseAgentTurn(text);
  }

  get name(): string {
    return this.speaker.name;
  }

  get isHost(): boolean {
    return this.speaker.isHost;
  }
}
