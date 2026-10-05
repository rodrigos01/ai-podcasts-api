import { z } from "zod";
import { voiceHintSchema } from "./common.schema";

// An empty string from a wizard LLM's structured output means "not set", the
// same as an absent key — see the accent comment below.
const optionalText = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

export const personInputSchema = z.object({
  name: z.string().min(1),
  // A free-text voice hint (e.g. "warm, gravelly older British male"), not a
  // catalog pick — see common.schema.ts's voiceHintSchema. Fed into
  // voiceResolution.service.ts at generation time, alongside persona/accent/
  // name, to derive a Voice Design description (hosts, and guests who need
  // an accent) or Voice Library search filters (other guests).
  voice: voiceHintSchema,
  persona: z.string().min(1),
  // A short, plain-English description of a distinctive spoken accent (e.g.
  // "Northern Irish", "light French accent") — optional, and only meant to
  // be set when the persona specifically calls for one; an ordinary/neutral
  // voice should leave this unset rather than have one invented for it. Fed
  // into voiceResolution.service.ts's voice-design/library-search prompts —
  // a guest with an accent set is routed to Voice Design instead of the
  // Library, since the Library's accent taxonomy can't express "a native
  // speaker of one language carrying an accent while speaking another" (see
  // AGENTS.md). The wizard LLMs (podcastWizard/episodeWizard) populate this
  // via Gemini's structured output, which — unlike a client's own request
  // body — can't always be trusted to omit an optional key it doesn't want
  // to set; the preprocess step treats an empty string as "no accent" the
  // same as an absent key, rather than failing `.min(1)` re-validation.
  accent: optionalText,
  // English counterparts of `persona` and `accent`, written by the same
  // wizard LLM call that wrote the originals (identical to them when the
  // show is already in English). `persona`/`accent` stay in the show's own
  // language for display and for script generation; these two are what
  // voiceResolution.service.ts sends to Voice Design, which gives better
  // voices from English prompts and still speaks any language with the
  // intended accent. Optional because people created before they existed
  // (and clients that don't echo them) lack them — the voice service
  // translates on demand in that case. Kept in sync with persona/accent on
  // host edits by podcast.repository.ts's reconcileEnglishFields.
  personaEn: optionalText,
  accentEn: optionalText,
});

// What clients send when saving a person (confirming a wizard, editing a
// host): the wizard-facing shape plus the Voice Design prompt. Kept out of
// personInputSchema on purpose — that one is also the wizards' LLM output
// schema, and the prompt is built by the server, never written by the model.
export const personSaveSchema = personInputSchema.extend({
  // The exact Voice Design prompt (see llm/prompts/voiceResolution.prompts.ts's
  // buildVoiceDesignInput) the person's voice is designed from. The wizard
  // responses carry it, and it's stored on confirm; the server writes it
  // itself (from personaEn/accentEn) whenever a person doesn't have one yet.
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
