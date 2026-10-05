import { registerDesignedVoices } from "../data/designedVoice.repository";
import { designVoice } from "../llm/ttsClient";
import { HttpError } from "../utils/HttpError";

// How many candidates one design call produces.
export const CANDIDATES_PER_DESIGN = 3;

/**
 * Designs `CANDIDATES_PER_DESIGN` voices from one prompt, in parallel, and
 * registers them under `sessionId` so they can be cleaned up when the user
 * saves (keeping only their pick). Returns whichever succeeded — each is an
 * independent, billed Voice Design call and a transient failure of one
 * shouldn't discard the others — and only fails when none did. A voice that
 * was created but couldn't be registered is not returned (it would be
 * untracked), but is left to Google's own expiry.
 */
export async function designCandidates(input: {
  ownerId: string;
  sessionId: string;
  prompt: string;
}): Promise<string[]> {
  const results = await Promise.allSettled(
    Array.from({ length: CANDIDATES_PER_DESIGN }, () => designVoice({ voiceDescription: input.prompt })),
  );

  const voiceIds = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (voiceIds.length === 0) {
    const reasons = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    console.error("Voice design failed for every candidate:", reasons);
    throw HttpError.badGateway("Voice design failed, try again");
  }

  const now = Date.now();
  await registerDesignedVoices(
    voiceIds.map((voiceId) => ({
      voiceId,
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      prompt: input.prompt,
      createdAt: now,
    })),
  );
  return voiceIds;
}
