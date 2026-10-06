import { fetchVoiceSample } from "../llm/ttsClient";
import { buildWav } from "../utils/wav";

// The preview endpoint is public, so every request is otherwise a Voices API
// call. A handful of recent previews (~1 MB each) absorbs a client replaying
// the same candidate, or several people loading the same one.
const MAX_CACHED_PREVIEWS = 8;
const cache = new Map<string, Buffer>();

/** A voice's sample as a complete WAV file, or null if the voice has none. */
export async function getVoicePreviewWav(voiceId: string): Promise<Buffer | null> {
  const cached = cache.get(voiceId);
  if (cached) {
    cache.delete(voiceId);
    cache.set(voiceId, cached); // most recently used goes last
    return cached;
  }

  const sample = await fetchVoiceSample(voiceId);
  if (!sample) return null;

  const wav = buildWav(sample.format, sample.pcm);
  cache.set(voiceId, wav);
  if (cache.size > MAX_CACHED_PREVIEWS) {
    cache.delete(cache.keys().next().value as string);
  }
  return wav;
}
