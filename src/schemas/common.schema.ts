import { z } from "zod";
import { normalizeLanguageCode } from "../utils/languageCode";

// A free-text voice hint (age, tone, gender, pacing — e.g. "warm, gravelly
// older British male"), not a pick from a fixed catalog. The Gemini 3.8
// Flash TTS migration replaced the old 30-ID `VOICE_IDS` enum (constants/
// voices.ts, still used by the standalone GET /voices catalog endpoint,
// otherwise unrelated now) with dynamic Voice Design (hosts) / Voice
// Library (guests) resolution at generation time — see
// services/episodeGeneration/voiceResolution.service.ts. This field is the
// input to that resolution, not a validated identifier.
export const voiceHintSchema = z.string().min(1).max(300);

const isBlank = (value: unknown) => value === null || (typeof value === "string" && value.trim() === "");

// Optional free text that clients echo back as "" (or null) when the user left
// it blank. Blank is treated exactly as if the field weren't sent. NOTE: the
// parsed object still carries the key, with an `undefined` value — never pass
// it to Firestore as-is (it rejects undefined).
export const optionalText = z.preprocess(
  (value) => (isBlank(value) ? undefined : value),
  z.string().min(1).optional(),
);

// Same, for PATCH: absent means "leave unchanged", but blank ("" or null)
// means "clear it" and is normalized to null.
export const clearableText = z.preprocess(
  (value) => (isBlank(value) ? null : value),
  z.string().min(1).nullable().optional(),
);

export const episodeLengthSchema = z.enum(["short", "medium", "long"]);

// The language a podcast is spoken in, as a BCP-47 tag ("en-US", "pt-BR"), used
// to design voices. Lenient on purpose: "en_US" is canonicalised, and anything
// unrecognisable (from a client or the wizard LLM) is treated as not set instead
// of failing the request. May come out as an explicit `undefined`, so
// repositories must omit it rather than store it (Firestore rejects undefined).
export const languageCodeSchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeLanguageCode(value) : undefined),
  z.string().optional(),
);
