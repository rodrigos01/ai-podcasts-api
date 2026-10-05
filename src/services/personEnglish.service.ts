import { generateText } from "../llm/geminiClient";
import {
  buildEnglishVoiceInputPrompt,
  buildVoiceDesignInput,
  ENGLISH_VOICE_INPUT_SYSTEM_INSTRUCTION,
  englishVoiceInputSchema,
} from "../llm/prompts/voiceResolution.prompts";
import type { Person, PersonInput } from "../schemas/person.schema";
import type { PodcastUpdateInput } from "../schemas/podcast.schema";
import { englishSourceChanged, reconcileEnglishFields, reconcileVoicePrompt } from "../utils/englishFields";

type HostUpdateInput = NonNullable<PodcastUpdateInput["hosts"]>[number];
// The text fields everything here reads and writes — deliberately not the whole
// person, so stored people (with their server-managed voice fields) fit too.
type PersonText = Pick<PersonInput, "name" | "voice" | "persona" | "accent" | "personaEn" | "accentEn" | "voicePrompt">;
type Translatable = Pick<PersonInput, "persona" | "voice" | "accent">;

/**
 * Whether a person already carries what Voice Design needs: an English
 * persona, and an English accent if they have an accent set. (A person whose
 * accent is only mentioned in the voice hint has no `accent`; whether they
 * have an `accentEn` was decided when their English fields were written.)
 */
export function hasEnglishFields(
  person: Pick<PersonInput, "accent" | "personaEn" | "accentEn">,
): person is typeof person & { personaEn: string } {
  return !!person.personaEn && (!person.accent || !!person.accentEn);
}

/** One small call: persona (and an accent, if any is stated) in English. */
export async function translateForVoice(
  person: Translatable,
): Promise<{ personaEn: string; accentEn?: string }> {
  const result = await generateText({
    systemInstruction: ENGLISH_VOICE_INPUT_SYSTEM_INSTRUCTION,
    prompt: buildEnglishVoiceInputPrompt(person.persona, person.voice, person.accent),
    schema: englishVoiceInputSchema,
  });
  return { personaEn: result.personaEn, ...(result.accentEn ? { accentEn: result.accentEn } : {}) };
}

/**
 * Returns `person` with its English persona/accent filled in, writing them
 * if they're missing. The server does this itself when it saves a person
 * (podcast create/update, episode create) because the wizards' output
 * passes through a client that may not echo these fields back — nothing
 * stored so far has ever carried them. Best-effort: if the call fails, the
 * person is saved as-is and voiceResolution.service.ts translates on demand
 * when their voice is designed.
 */
export async function withEnglishFields<T extends PersonText>(person: T): Promise<T> {
  if (hasEnglishFields(person)) return person;
  try {
    const english = await translateForVoice(person);
    // Rebuilt without the old English keys so none is left behind as
    // `undefined`, which Firestore rejects.
    const { personaEn: _personaEn, accentEn: _accentEn, ...rest } = person;
    return { ...rest, ...english } as T;
  } catch (err) {
    console.error("Could not write English persona/accent for a person; saving without them:", err);
    return person;
  }
}

/**
 * Returns `person` with its Voice Design prompt set, building it when missing
 * (writing the English persona/accent first if they're missing too). The
 * prompt is a plain function of name + English persona + English accent, so
 * everything that needs one — the wizard responses, saving a person, and
 * voice design itself — goes through here and agrees on the same string. If
 * the English fields can't be written, falls back to the original persona and
 * accent rather than leaving the person without one.
 */
export async function withVoicePrompt<T extends PersonText>(person: T): Promise<T & { voicePrompt: string }> {
  if (person.voicePrompt) return person as T & { voicePrompt: string };
  const english = await withEnglishFields(person);
  return {
    ...english,
    voicePrompt: buildVoiceDesignInput(
      english.name,
      english.personaEn ?? english.persona,
      english.accentEn ?? english.accent,
    ),
  };
}

/**
 * `withVoicePrompt` for the wizard responses, where the prompt is a bonus
 * field: if anything goes wrong the person comes back without one, and the
 * wizard call itself never fails over it (so existing clients, which don't
 * use the field, are unaffected).
 */
export async function withVoicePromptIfPossible<T extends PersonText>(
  person: T,
): Promise<T | (T & { voicePrompt: string })> {
  try {
    return await withVoicePrompt(person);
  } catch (err) {
    console.error("Could not build a voice prompt for a wizard suggestion; omitting it:", err);
    return person;
  }
}

/**
 * Prepares a podcast update's hosts for saving: keeps/drops each existing
 * host's stored English fields per reconcileEnglishFields, and writes fresh
 * ones for a new host or one whose persona, voice hint or accent changed.
 * An untouched host is left exactly as stored — adding English fields to a
 * host whose voice is already designed would change its voice hash and
 * trigger a pointless re-design.
 */
export async function prepareHostsForUpdate(
  currentHosts: Person[],
  incoming: HostUpdateInput[],
): Promise<HostUpdateInput[]> {
  const byId = new Map(currentHosts.map((host) => [host.id, host]));
  return Promise.all(
    incoming.map(async (host) => {
      const current = host.id ? byId.get(host.id) : undefined;
      const { personaEn: _personaEn, accentEn: _accentEn, voicePrompt: incomingPrompt, ...rest } = host;
      const voicePrompt = current ? reconcileVoicePrompt(current, host) : incomingPrompt;
      const prepared: HostUpdateInput = {
        ...rest,
        ...reconcileEnglishFields(current ?? host, host),
        ...(voicePrompt ? { voicePrompt } : {}),
      };
      // An untouched legacy host (no English fields) is left as stored; anyone
      // new, edited, or already carrying English fields gets a prompt.
      const needsWork =
        !current || englishSourceChanged(current, host) || (!prepared.voicePrompt && hasEnglishFields(prepared));
      return needsWork ? withVoicePrompt(prepared) : prepared;
    }),
  );
}
