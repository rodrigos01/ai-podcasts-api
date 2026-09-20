import { describe, expect, it } from "vitest";
import { parseAgentTurn } from "../src/services/episodeGeneration/agent";
import { END_EPISODE_MARKER } from "../src/llm/prompts/hostPersona.prompts";

describe("parseAgentTurn", () => {
  it("returns plain speech with endEpisode false when there's no marker", () => {
    expect(parseAgentTurn("Yeah, exactly that.")).toEqual({
      speech: "Yeah, exactly that.",
      endEpisode: false,
    });
  });

  it("strips a trailing END_EPISODE_MARKER and sets endEpisode true", () => {
    const raw = `That's a wrap for tonight.\n${END_EPISODE_MARKER}`;
    expect(parseAgentTurn(raw)).toEqual({
      speech: "That's a wrap for tonight.",
      endEpisode: true,
    });
  });

  it("collapses an internal blank-line paragraph break into a single space", () => {
    // Regression test: a turn's own text must never contain "\n\n", since
    // that's the exact separator transcriptBuilder.ts uses between turns —
    // an internal paragraph break whose next line looks like "Word:" would
    // otherwise be misread as a new speaker label downstream.
    const raw = "Yeah, exactly.\n\nWatch this: it's wild.";
    const result = parseAgentTurn(raw);
    expect(result.speech).not.toContain("\n\n");
    expect(result.speech).toBe("Yeah, exactly. Watch this: it's wild.");
  });

  it("throws if the speech is empty after stripping the marker", () => {
    expect(() => parseAgentTurn(`   \n${END_EPISODE_MARKER}`)).toThrow();
  });
});
