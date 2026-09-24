import { z } from "zod";
import { voiceIdSchema } from "./common.schema";

export const personInputSchema = z.object({
  name: z.string().min(1),
  voice: voiceIdSchema,
  persona: z.string().min(1),
  // A short, plain-English description of a distinctive spoken accent (e.g.
  // "Northern Irish", "light French accent") — optional, and only meant to
  // be set when the persona specifically calls for one; an ordinary/neutral
  // voice should leave this unset rather than have one invented for it. Fed
  // into producerPrompt.service.ts's Director's note, one line per speaker
  // who has one. The wizard LLMs (podcastWizard/episodeWizard) populate this
  // via Gemini's structured output, which — unlike a client's own request
  // body — can't always be trusted to omit an optional key it doesn't want
  // to set; the preprocess step treats an empty string as "no accent" the
  // same as an absent key, rather than failing `.min(1)` re-validation.
  accent: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
});

export const personSchema = personInputSchema.extend({
  id: z.string().min(1),
});

export type PersonInput = z.infer<typeof personInputSchema>;
export type Person = z.infer<typeof personSchema>;
