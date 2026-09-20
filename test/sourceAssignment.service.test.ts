import { describe, expect, it } from "vitest";
import { normalizeSourceAssignment } from "../src/services/episodeGeneration/sourceAssignment.service";
import type { Speaker } from "../src/services/episodeGeneration/speakerSelection";
import type { Source } from "../src/schemas/source.schema";

function speaker(id: string, isHost: boolean): Speaker {
  return { id, name: id, voice: "Kore", persona: "test persona", isHost };
}

function source(id: string): Source {
  return { id, title: id, contents: `contents of ${id}`, sourceType: "text", createdAt: 0 };
}

describe("normalizeSourceAssignment", () => {
  const marcus = speaker("marcus", true);
  const priya = speaker("priya", false);
  const speakers: [Speaker, Speaker] = [marcus, priya];
  const sourceA = source("a");
  const sourceB = source("b");
  const sources = [sourceA, sourceB];

  it("routes each source to exactly the speakers the model assigned it to", () => {
    const draft = {
      assignments: [
        { sourceId: "a", speakerIds: ["marcus"] },
        { sourceId: "b", speakerIds: ["priya"] },
      ],
    };
    const result = normalizeSourceAssignment(draft, speakers, sources);
    expect(result.get("marcus")).toEqual([sourceA]);
    expect(result.get("priya")).toEqual([sourceB]);
  });

  it("supports assigning a single source to both speakers", () => {
    const draft = { assignments: [{ sourceId: "a", speakerIds: ["marcus", "priya"] }] };
    const result = normalizeSourceAssignment(draft, speakers, [sourceA]);
    expect(result.get("marcus")).toEqual([sourceA]);
    expect(result.get("priya")).toEqual([sourceA]);
  });

  it("drops a hallucinated source id rather than throwing", () => {
    const draft = { assignments: [{ sourceId: "not-a-real-source", speakerIds: ["marcus"] }] };
    const result = normalizeSourceAssignment(draft, speakers, sources);
    // The real sources were never validly claimed, so they fall back to everyone (see next test) —
    // this just confirms the bogus entry doesn't blow up or leak a phantom source.
    expect(result.get("marcus")).toEqual(sources);
    expect(result.get("priya")).toEqual(sources);
  });

  it("drops an unrecognized speaker id within an otherwise-valid entry", () => {
    const draft = { assignments: [{ sourceId: "a", speakerIds: ["not-a-real-speaker"] }] };
    const result = normalizeSourceAssignment(draft, speakers, sources);
    // "a" was never validly claimed (its only target speaker id was invalid) — falls back to everyone.
    expect(result.get("marcus")).toContain(sourceA);
    expect(result.get("priya")).toContain(sourceA);
  });

  it("falls back to giving every speaker any source the model never validly assigned", () => {
    const draft = { assignments: [{ sourceId: "a", speakerIds: ["marcus"] }] }; // "b" never mentioned
    const result = normalizeSourceAssignment(draft, speakers, sources);
    expect(result.get("marcus")).toEqual([sourceA, sourceB]);
    expect(result.get("priya")).toEqual([sourceB]);
  });

  it("never drops a source entirely, even with a completely empty draft", () => {
    const result = normalizeSourceAssignment({ assignments: [] }, speakers, sources);
    expect(result.get("marcus")).toEqual(sources);
    expect(result.get("priya")).toEqual(sources);
  });
});
