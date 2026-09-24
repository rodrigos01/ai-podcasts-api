import { z } from "zod";

// A free-text voice hint (age, tone, gender, pacing — e.g. "warm, gravelly
// older British male"), not a pick from a fixed catalog. The Gemini 3.8
// Flash TTS migration replaced the old 30-ID `VOICE_IDS` enum (constants/
// voices.ts, still used by the standalone GET /voices catalog endpoint,
// otherwise unrelated now) with dynamic Voice Design (hosts) / Voice
// Library (guests) resolution at generation time — see
// services/episodeGeneration/voiceResolution.service.ts. This field is the
// input to that resolution, not a validated identifier.
export const voiceHintSchema = z.string().min(1).max(300);

export const episodeLengthSchema = z.enum(["short", "medium", "long"]);
