import type { Request, Response } from "express";
import { isDesignedVoiceId } from "../llm/ttsClient";
import { getVoicePreviewWav } from "../services/voicePreview.service";
import { HttpError } from "../utils/HttpError";
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
