import { z } from "zod";
import { voiceHintSchema } from "./common.schema";

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
  accent: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
});

export const personSchema = personInputSchema.extend({
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
});

export type PersonInput = z.infer<typeof personInputSchema>;
export type Person = z.infer<typeof personSchema>;
