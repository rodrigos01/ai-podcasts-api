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
 * `rawText` is plain dialogue, optionally followed by a trailing
 * END_EPISODE_MARKER line (see hostPersona.prompts.ts). Not a zod schema
 * anymore — there's no JSON to validate, just a marker to strip.
 */
function parseAgentTurn(rawText: string): AgentTurn {
  const markerIndex = rawText.lastIndexOf(END_EPISODE_MARKER);
  const endEpisode = markerIndex !== -1;
  const speech = (endEpisode ? rawText.slice(0, markerIndex) : rawText).trim();
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
    // can't end the episode) — no marker-stripping needed, just trim.
    const speech = text.trim();
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
