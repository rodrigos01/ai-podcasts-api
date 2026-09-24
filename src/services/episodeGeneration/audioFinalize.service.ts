import { spawn } from "node:child_process";
import { putFinalAudio } from "../../storage/audioCache.repository";
import { getEpisode } from "../../data/episode.repository";
import { buildWav, DEFAULT_PCM_FORMAT } from "../../utils/wav";
import { cleanupGuestVoice } from "./voiceResolution.service";

/**
 * Encodes a complete WAV buffer to Ogg Opus via a real `ffmpeg` subprocess
 * (piped over stdin/stdout — no temp files). The new Gemini 3.8 Flash TTS
 * model has no compressed output of its own (WAV/raw PCM, mulaw, alaw
 * only — see AGENTS.md), so this is now the only place Ogg Opus encoding
 * happens, replacing the old pipeline's hand-rolled Ogg-page stitching
 * (utils/oggStitch.ts, deleted) entirely with one real encoder pass.
 * Requires `ffmpeg` with libopus support in the runtime image (see
 * Dockerfile).
 */
function encodeToOggOpus(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-i", "pipe:0", "-c:a", "libopus", "-f", "ogg", "pipe:1"]);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    ffmpeg.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderrChunks).toString("utf8")}`));
      }
    });

    ffmpeg.stdin.end(wav);
  });
}

/**
 * Runs once, after an episode's single streaming TTS synthesis call has
 * fully and successfully completed (see audio.service.ts's
 * leadGeneration, the only caller) — encodes the complete PCM to the one
 * final Ogg Opus file every future `/stream` request will serve as a plain
 * static resource, and deletes the episode's guest's voice if it was a
 * Voice-Design mint (never for a Library voice — see
 * voiceResolution.service.ts's cleanupGuestVoice). Deliberately NOT called
 * on a failed attempt: the guest's already-resolved voice stays valid and
 * reusable for a retry (a fresh `/stream` request, or `/regenerate`) — the
 * synthesis call failing doesn't mean anything was wrong with the voice
 * itself.
 */
export async function finalizeEpisodeAudio(podcastId: string, episodeId: string, pcm: Buffer): Promise<void> {
  const wav = buildWav(DEFAULT_PCM_FORMAT, pcm);
  const ogg = await encodeToOggOpus(wav);
  await putFinalAudio(podcastId, episodeId, ogg);

  const episode = await getEpisode(podcastId, episodeId);
  const guest = episode?.guests[0];
  if (guest) await cleanupGuestVoice(guest);
}
