import { describe, expect, it } from "vitest";
import { generateBaseTtsPrompt } from "../src/services/episodeGeneration/producerPrompt.service";
import type { Speaker } from "../src/services/episodeGeneration/speakerSelection";

function speaker(overrides: Pick<Speaker, "id" | "name" | "persona"> & Partial<Speaker>): Speaker {
  return { voice: "Puck", isHost: true, ...overrides };
}

describe("generateBaseTtsPrompt", () => {
  it("renders a generic sample context and each speaker's persona verbatim, with no Director's note when neither has an accent", () => {
    const marcus = speaker({ id: "1", name: "Marcus", persona: "Night-owl engineer." });
    const priya = speaker({ id: "2", name: "Priya", persona: "Curious hacker." });

    const prompt = generateBaseTtsPrompt([marcus, priya]);

    expect(prompt).toContain("### Sample Context");
    expect(prompt).toContain("### Audio Profile: Marcus\nNight-owl engineer.");
    expect(prompt).toContain("### Audio Profile: Priya\nCurious hacker.");
    expect(prompt).not.toContain("Director's note");
  });

  it("adds a Director's note line only for the speaker(s) who have an accent set", () => {
    const marcus = speaker({
      id: "1",
      name: "Marcus",
      persona: "Night-owl engineer.",
      accent: "Northern Irish",
    });
    const priya = speaker({ id: "2", name: "Priya", persona: "Curious hacker." });

    const prompt = generateBaseTtsPrompt([marcus, priya]);

    expect(prompt).toContain("### Director's note\nAccent: Marcus — Northern Irish");
    expect(prompt).not.toContain("Accent: Priya");
  });

  it("labels each speaker using the same first-name-only convention as the rest of the pipeline", () => {
    const camRivera = speaker({ id: "1", name: "Cam Rivera", persona: "A." });
    const camChen = speaker({ id: "2", name: "Cam Chen", persona: "B." });

    const prompt = generateBaseTtsPrompt([camRivera, camChen]);

    // Shared first name forces the speakerLabel() fallback to full names.
    expect(prompt).toContain("### Audio Profile: Cam Rivera");
    expect(prompt).toContain("### Audio Profile: Cam Chen");
  });
});
