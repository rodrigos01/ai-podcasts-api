import { describe, expect, it } from "vitest";
import type { Episode } from "../src/schemas/episode.schema";
import type { Person } from "../src/schemas/person.schema";
import type { Podcast } from "../src/schemas/podcast.schema";
import { voiceHash } from "../src/utils/voiceHash";
import { presentEpisode, presentPodcast } from "../src/utils/voicePreview";

const ORIGIN = "https://api.example.com";

function person(overrides: Partial<Person> = {}): Person {
  const base = { id: "p1", name: "Maya", voice: "warm", persona: "A producer." };
  return {
    ...base,
    resolvedVoiceId: "voice_abc",
    resolvedVoiceOrigin: "design",
    resolvedVoiceHash: voiceHash(base),
    ...overrides,
  };
}

const podcast = (hosts: Person[]) => ({ id: "pod", hosts }) as Podcast;
const episode = (guests: Person[]) => ({ id: "ep", guests }) as Episode;

describe("presentPodcast", () => {
  it("adds an absolute preview URL to a host with a current voice", () => {
    const [host] = presentPodcast(ORIGIN, podcast([person()])).hosts;
    expect(host?.voicePreviewUrl).toBe("https://api.example.com/voices/voice_abc/preview");
  });

  it("adds none for a host without a voice or with a stale one (e.g. from before the platform move)", () => {
    const { hosts } = presentPodcast(
      ORIGIN,
      podcast([
        person({ resolvedVoiceId: null, resolvedVoiceHash: null }),
        person({ resolvedVoiceHash: "stale" }),
      ]),
    );
    expect(hosts.every((h) => !("voicePreviewUrl" in h))).toBe(true);
  });

  it("keeps a picked voice previewable even after the persona text changed", () => {
    const [host] = presentPodcast(ORIGIN, podcast([person({ resolvedVoiceHash: "stale", resolvedVoicePinned: true })])).hosts;
    expect(host?.voicePreviewUrl).toContain("/voices/voice_abc/preview");
  });
});

describe("presentEpisode", () => {
  it("adds a URL only for a guest whose voice was picked", () => {
    const { guests } = presentEpisode(
      ORIGIN,
      episode([person({ id: "g1", resolvedVoicePinned: true }), person({ id: "g2" })]),
    );
    expect(guests[0]?.voicePreviewUrl).toBe("https://api.example.com/voices/voice_abc/preview");
    // A designed-at-generation guest voice is deleted once the audio is done.
    expect(guests[1]).not.toHaveProperty("voicePreviewUrl");
  });
});
