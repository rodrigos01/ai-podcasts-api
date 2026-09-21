import { describe, expect, it } from "vitest";
import { selectCast, speakerLabel } from "../src/services/episodeGeneration/speakerSelection";
import type { Person } from "../src/schemas/person.schema";

function person(id: string, name: string): Person {
  return { id, name, voice: "Puck", persona: "test persona" };
}

describe("selectCast", () => {
  it("1 host + 1 guest: host always kicks off", () => {
    const host = person("h1", "Host");
    const guest = person("g1", "Guest");
    for (let i = 0; i < 20; i++) {
      const cast = selectCast([host], [guest]);
      expect(cast.kickoffSpeakerId).toBe("h1");
    }
  });

  it("2 hosts: kickoff is randomly distributed across both", () => {
    const h1 = person("h1", "A");
    const h2 = person("h2", "B");
    const kickoffs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      kickoffs.add(selectCast([h1, h2], []).kickoffSpeakerId);
    }
    expect(kickoffs).toEqual(new Set(["h1", "h2"]));
  });

  it("throws on 0 total voices", () => {
    expect(() => selectCast([], [])).toThrow();
  });

  it("throws on 3 hosts", () => {
    expect(() =>
      selectCast([person("h1", "A"), person("h2", "B"), person("h3", "C")], []),
    ).toThrow();
  });

  it("throws on 2 guests", () => {
    expect(() => selectCast([], [person("g1", "A"), person("g2", "B")])).toThrow();
  });

  it("throws on 2 hosts + 1 guest", () => {
    expect(() =>
      selectCast([person("h1", "A"), person("h2", "B")], [person("g1", "C")]),
    ).toThrow();
  });
});

describe("speakerLabel", () => {
  it("returns the first name when the two speakers' first names differ", () => {
    expect(speakerLabel("Maya Cruz", "Camille Laurent")).toBe("Maya");
  });

  it("returns the first name unchanged for an already-single-word name", () => {
    expect(speakerLabel("Marcus", "Priya")).toBe("Marcus");
  });

  it("falls back to the full name when both speakers share a first name", () => {
    expect(speakerLabel("Cam Rivera", "Cam Chen")).toBe("Cam Rivera");
    expect(speakerLabel("Cam Chen", "Cam Rivera")).toBe("Cam Chen");
  });

  it("treats the first-name collision check case-insensitively", () => {
    expect(speakerLabel("cam Rivera", "Cam Chen")).toBe("cam Rivera");
  });
});
