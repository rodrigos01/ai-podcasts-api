import { describe, expect, it } from "vitest";
import { episodeWizardSystemInstruction } from "../src/llm/prompts/episodeWizard.prompts";
import { extraInstructionsSection } from "../src/llm/prompts/episodeHistory.prompts";
import { buildScriptSystemInstruction } from "../src/llm/prompts/scriptGeneration.prompts";
import type { Podcast } from "../src/schemas/podcast.schema";

const podcast: Podcast = {
  id: "p", title: "Show", description: "d", structure: "s", hosts: [], ownerId: "o", createdAt: 1, updatedAt: 1,
};

describe("extra instructions", () => {
  it("renders nothing when unset or blank", () => {
    expect(extraInstructionsSection(undefined)).toBe("");
    expect(extraInstructionsSection("  \n ")).toBe("");
  });

  it("is added to the wizard and script system instructions only when set", () => {
    const withText = { ...podcast, extraInstructions: "EXTRA-RULE" };
    expect(episodeWizardSystemInstruction(withText, "medium", [])).toContain("EXTRA-RULE");
    expect(buildScriptSystemInstruction({ podcast: withText } as never)).toContain("EXTRA-RULE");
    expect(episodeWizardSystemInstruction(podcast, "medium", [])).not.toContain("Extra instructions");
    expect(buildScriptSystemInstruction({ podcast } as never)).not.toContain("Extra instructions");
  });
});
