import type { Person } from "../../schemas/person.schema";

export interface Speaker extends Person {
  isHost: boolean;
}

export interface Cast {
  speakers: [Speaker, Speaker];
  kickoffSpeakerId: string;
}

/**
 * One-time, whole-episode decision: which 2 voices are cast, and who opens.
 * Every episode has exactly 2 active voices (enforced at the schema level),
 * so per-turn "who speaks next" downstream is trivial strict alternation —
 * the real selection problem lives here, before the conversation starts.
 */
export function selectCast(hosts: Person[], guests: Person[]): Cast {
  const speakers: Speaker[] = [
    ...hosts.map((h) => ({ ...h, isHost: true })),
    ...guests.map((g) => ({ ...g, isHost: false })),
  ];

  if (speakers.length !== 2) {
    throw new Error(
      `Expected exactly 2 cast speakers, got ${speakers.length} (hosts=${hosts.length}, guests=${guests.length})`,
    );
  }
  if (guests.length > 1) {
    throw new Error("An episode can have at most 1 guest");
  }

  const [a, b] = speakers as [Speaker, Speaker];

  // Guests never open an episode; between 2 hosts, kickoff is random.
  const kickoffSpeakerId = !a.isHost ? b.id : !b.isHost ? a.id : Math.random() < 0.5 ? a.id : b.id;

  return { speakers: [a, b], kickoffSpeakerId };
}

/**
 * The label a speaker is referred to by in the generated transcript, the
 * TTS voice-alias mapping (audio.service.ts's resolveCastVoices), and the
 * script-writer's own output-format instructions (scriptGeneration.prompts.ts)
 * — first name only, since a shorter, simpler label is both what real
 * podcast attribution looks like and easier for a single LLM call to stay
 * consistent with across a whole episode than a full name. Falls back to
 * the full name only when the two cast members share a first name, since
 * two speakers can't both be labeled "Maya" and stay distinguishable to a
 * listener or to the TTS voice mapping.
 */
export function speakerLabel(name: string, otherName: string): string {
  const firstNameOf = (n: string) => n.trim().split(/\s+/)[0] ?? n;
  const mine = firstNameOf(name);
  return mine.toLowerCase() === firstNameOf(otherName).toLowerCase() ? name : mine;
}
