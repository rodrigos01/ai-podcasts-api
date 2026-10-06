import type { Person, PersonInput } from "../schemas/person.schema";
import type { PodcastUpdateInput } from "../schemas/podcast.schema";
import { buildVoiceDesignInput } from "../llm/prompts/voiceResolution.prompts";

type HostUpdateInput = NonNullable<PodcastUpdateInput["hosts"]>[number];

// The text fields the prompt is built from — deliberately not the whole
// person, so stored people (with their server-managed voice fields) fit too.
type PromptFields = Pick<PersonInput, "name" | "persona" | "accent" | "voicePrompt">;

/**
 * `person` with its Voice Design prompt set, built when missing: the name, the
 * persona as written (any language — the podcast's language code goes to the
 * Voices API alongside it) and the accent, if there is one. A prompt that's
 * already there (stored, or edited by the client) is kept as-is.
 */
export function withVoicePrompt<T extends PromptFields>(person: T): T & { voicePrompt: string } {
  if (person.voicePrompt) return person as T & { voicePrompt: string };
  return { ...person, voicePrompt: buildVoiceDesignInput(person.name, person.persona, person.accent) };
}

/**
 * The stored prompt a host edit keeps, mirroring what it's built from: a
 * prompt the client deliberately changed wins; otherwise the stored one is
 * kept unless the name, persona or accent it's built from changed, in which
 * case it's dropped (and rebuilt by withVoicePrompt). Returns only a defined
 * value — Firestore rejects `undefined`.
 */
export function reconcileVoicePrompt(current: PromptFields, incoming: PromptFields): string | undefined {
  if (incoming.voicePrompt !== undefined && incoming.voicePrompt !== current.voicePrompt) {
    return incoming.voicePrompt;
  }
  const stale =
    current.name !== incoming.name ||
    current.persona !== incoming.persona ||
    current.accent !== incoming.accent;
  return stale ? undefined : current.voicePrompt;
}

/**
 * Prepares an update's hosts (or an episode update's guests) for saving: each
 * keeps/drops/rebuilds its voice prompt per reconcileVoicePrompt, and one
 * that has none gets it built.
 */
export function prepareHostsForUpdate(currentHosts: Person[], incoming: HostUpdateInput[]): HostUpdateInput[] {
  const byId = new Map(currentHosts.map((host) => [host.id, host]));
  return incoming.map((host) => {
    const current = host.id ? byId.get(host.id) : undefined;
    const { voicePrompt: incomingPrompt, ...rest } = host;
    const voicePrompt = current ? reconcileVoicePrompt(current, host) : incomingPrompt;
    return withVoicePrompt({ ...rest, ...(voicePrompt ? { voicePrompt } : {}) });
  });
}
