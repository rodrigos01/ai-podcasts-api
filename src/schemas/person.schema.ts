import { z } from "zod";
import { voiceHintSchema } from "./common.schema";

// An empty string from a wizard LLM's structured output means "not set", the
// same as an absent key — see the accent comment below.
const optionalText = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

export const personInputSchema = z.object({
  name: z.string().min(1),
  // A free-text description of how the person sounds (e.g. "warm, gravelly
  // older British male"), not a catalog pick — see common.schema.ts's
  // voiceHintSchema. Display only: the voice itself is designed from the name,
  // persona and accent (see voicePrompt below).
  voice: voiceHintSchema,
  persona: z.string().min(1),
  // A short description of a distinctive spoken accent, in the same language
  // as the persona (e.g. "Northern Irish", "sotaque nordestino") — optional, and only meant to be
  // set when the persona specifically calls for one; an ordinary/neutral voice
  // should leave this unset rather than have one invented for it. It's the
  // accent line of the Voice Design prompt, stated explicitly because that is
  // far more effective than leaving the model to infer it from the persona.
  // The wizard LLMs populate this via Gemini's structured output, which —
  // unlike a client's own request body — can't always be trusted to omit an
  // optional key it doesn't want to set; the preprocess step treats an empty
  // string as "no accent" the same as an absent key, rather than failing
  // `.min(1)` re-validation.
  accent: optionalText,
});

// What clients send when saving a person (confirming a wizard, editing a
// host): the wizard-facing shape plus the Voice Design prompt. Kept out of
// personInputSchema on purpose — that one is also the wizards' LLM output
// schema, and the prompt is built by the server, never written by the model.
export const personSaveSchema = personInputSchema.extend({
  // The exact Voice Design prompt (see llm/prompts/voiceResolution.prompts.ts's
  // buildVoiceDesignInput: name, persona, accent) the person's voice is designed
  // from. The wizard responses carry it, and it's stored on confirm; the server
  // writes it itself whenever a person doesn't have one yet.
  // Not part of voiceHash: editing it never invalidates a stored voice.
  voicePrompt: optionalText,
  // The voice a client picked for this person from POST /voices/design
  // candidates (the id it got back). Echoing a GET response back sends the
  // current value, which is a no-op. Only ever used after the server has
  // checked it against the caller's own design session — anything else is
  // ignored as if it hadn't been sent (see voiceSelection.service.ts). The
  // stored field below is the same name; origin/hash stay server-managed.
  resolvedVoiceId: z.string().min(1).optional(),
});

export const personSchema = personSaveSchema.extend({
  id: z.string().min(1),
  // Server-managed voice-resolution state — never accepted from a client
  // (absent from personInputSchema), only ever set by
  // voiceResolution.service.ts. Null until first resolved.
  // - Host: resolved once, persisted here on the Podcast document, and
  //   reused for every future episode as long as resolvedVoiceHash still
  //   matches a hash of (name, persona, accent, voice) — an edit to any of
  //   those invalidates the cache and triggers a fresh Voice Design call.
  //   A host's designed voice is never deleted.
  // - Guest: resolved fresh at the start of every generation attempt
  //   (initial or /regenerate) — resolvedVoiceHash is unused for guests.
  //   Deleted via voiceResolution.service.ts's cleanupGuestVoice once that
  //   attempt's audio generation finishes, if resolvedVoiceOrigin is
  //   "design" (never for "library" voices, which aren't ours to delete).
  resolvedVoiceId: z.string().nullable(),
  resolvedVoiceOrigin: z.enum(["design", "library"]).nullable(),
  resolvedVoiceHash: z.string().nullable(),
  // True when the voice is one the user picked (not one the server designed
  // on its own): it's kept until they pick another or the prompt it was
  // designed from changes, instead of being re-designed on a hash mismatch,
  // and a guest's isn't deleted after audio finalizes. Absent on older docs.
  resolvedVoicePinned: z.boolean().optional(),
});

export type ResolvedVoiceFields = Pick<
  Person,
  "resolvedVoiceId" | "resolvedVoiceOrigin" | "resolvedVoiceHash" | "resolvedVoicePinned"
>;
export type PersonInput = z.infer<typeof personSaveSchema>;
export type Person = z.infer<typeof personSchema>;
