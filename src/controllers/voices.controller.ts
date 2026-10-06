import type { Request, Response } from "express";
import { z } from "zod";
import { requireUserId } from "../middleware/requireAuth";
import { isDesignedVoiceId } from "../llm/ttsClient";
import { designCandidates } from "../services/voiceDesign.service";
import { getVoicePreviewWav } from "../services/voicePreview.service";
import { HttpError } from "../utils/HttpError";
import { publicOrigin, voicePreviewUrl } from "../utils/voicePreview";
import { requireParam } from "../utils/params";

// Public on purpose (like the rest of /voices): a plain <audio src> or
// ExoPlayer can't attach an auth header, and a voice id is an unguessable
// uuid.
export async function preview(req: Request, res: Response) {
  const voiceId = requireParam(req.params, "voiceId");
  if (!isDesignedVoiceId(voiceId)) throw HttpError.badRequest("Not a designed voice id");

  const wav = await getVoicePreviewWav(voiceId);
  if (!wav) throw HttpError.notFound("Voice not found");

  res.set({
    "Content-Type": "audio/wav",
    "Content-Length": String(wav.length),
    "Cache-Control": "public, max-age=3600",
  });
  res.send(wav);
}

const designRequestSchema = z.object({
  // A wizard run's id (from the wizard responses), or the podcast/episode id
  // when editing an existing one — see designedVoice.repository.ts.
  sessionId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(4000),
});

export async function design(req: Request, res: Response) {
  const input = designRequestSchema.parse(req.body);
  const voiceIds = await designCandidates({
    ownerId: requireUserId(req),
    sessionId: input.sessionId,
    prompt: input.prompt,
  });

  const origin = publicOrigin(req);
  res.json({
    sessionId: input.sessionId,
    voices: voiceIds.map((voiceId) => ({ voiceId, previewUrl: voicePreviewUrl(origin, voiceId) })),
  });
}
