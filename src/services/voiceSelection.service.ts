import {
  deleteDesignedVoiceRecords,
  listSessionVoices,
  markVoicesLinked,
  type DesignedVoice,
} from "../data/designedVoice.repository";
import { deleteVoice } from "../llm/ttsClient";
import type { Person } from "../schemas/person.schema";
import type { PickedVoice, VoiceDecision } from "../utils/voiceDecision";

export interface VoicePicker {
  /**
   * The voice to apply for a client-sent `resolvedVoiceId`, or null when it
   * isn't one of the caller's unlinked candidates in this session — which
   * covers no id, the person's own current voice echoed back, and a stale or
   * unknown one. All of those are handled as "no pick".
   */
  pick(resolvedVoiceId: string | undefined): PickedVoice | null;
  /**
   * After the save: links the applied picks, and deletes every other
   * candidate left in the session plus the stored voices the save replaced.
   * Best-effort — a failure here is logged and never fails the save.
   */
  finish(decisions: VoiceDecision[]): Promise<void>;
}

/**
 * Reads the session's candidates once per save. `sessionId` is a wizard run's
 * id, or the podcast/episode id when editing; without one no pick can be
 * valid and nothing is cleaned up (replaced voices still are).
 */
export async function createVoicePicker(ownerId: string, sessionId: string | undefined): Promise<VoicePicker> {
  const candidates: DesignedVoice[] = sessionId
    ? (await listSessionVoices(sessionId, ownerId)).filter((voice) => !voice.linked)
    : [];
  const byId = new Map(candidates.map((voice) => [voice.voiceId, voice]));

  return {
    pick(resolvedVoiceId) {
      const candidate = resolvedVoiceId ? byId.get(resolvedVoiceId) : undefined;
      return candidate ? { voiceId: candidate.voiceId, prompt: candidate.prompt } : null;
    },

    async finish(decisions) {
      const applied = new Set(
        decisions.flatMap((d) => (d.fields?.resolvedVoicePinned && d.fields.resolvedVoiceId ? [d.fields.resolvedVoiceId] : [])),
      );
      const replaced = decisions.flatMap((d) => (d.replacedVoiceId ? [d.replacedVoiceId] : []));
      const unused = candidates.map((voice) => voice.voiceId).filter((id) => !applied.has(id));
      try {
        await markVoicesLinked([...applied]);
        await Promise.all([...unused, ...replaced].map(deleteVoice));
        await deleteDesignedVoiceRecords([...unused, ...replaced]);
      } catch (err) {
        console.error(`Voice cleanup after save failed (session ${sessionId ?? "none"}):`, err);
      }
    },
  };
}

/**
 * Deletes the voices that belong to people being removed along with their
 * podcast or episode: a host's designed voice, and a guest's picked one (an
 * unpicked guest's is already deleted when its audio finishes). A voice with
 * no recorded hash predates this platform and isn't ours to delete.
 */
export async function deletePeopleVoices(people: Person[], kind: "host" | "guest"): Promise<void> {
  const ids = people.flatMap((person) => {
    if (!person.resolvedVoiceId || !person.resolvedVoiceHash) return [];
    if (kind === "guest" && !person.resolvedVoicePinned) return [];
    return [person.resolvedVoiceId];
  });
  try {
    await Promise.all(ids.map(deleteVoice));
    await deleteDesignedVoiceRecords(ids);
  } catch (err) {
    console.error("Failed to clean up voices of deleted people:", err);
  }
}
