/**
 * Lets "clear this episode's audio" kill audio that is being synthesized right now.
 *
 * Generation can be running on this process (an in-memory AbortController stops it at once) or
 * on another Cloud Run instance (nothing in memory to reach), so clearing also bumps a per-episode
 * `audioEpoch` in Firestore: every stream request remembers the epoch it started under, and a
 * generation gives up as soon as it sees a different one (see audio.service.ts).
 */
export class AudioCancelledError extends Error {
  constructor() {
    super("Audio generation was cancelled because the episode's audio was cleared");
    this.name = "AudioCancelledError";
  }
}

export function isAudioCancelled(err: unknown): boolean {
  return err instanceof AudioCancelledError;
}

const running = new Map<string, Set<AbortController>>();

function key(podcastId: string, episodeId: string): string {
  return `${podcastId}:${episodeId}`;
}

/** Registers a generation running on this process; returns a function that unregisters it. */
export function trackGeneration(podcastId: string, episodeId: string, controller: AbortController): () => void {
  const k = key(podcastId, episodeId);
  const set = running.get(k) ?? new Set<AbortController>();
  set.add(controller);
  running.set(k, set);
  return () => {
    set.delete(controller);
    if (set.size === 0) running.delete(k);
  };
}

/** Aborts every generation of the episode running on this process; returns how many. */
export function abortLocalGenerations(podcastId: string, episodeId: string): number {
  const set = running.get(key(podcastId, episodeId));
  if (!set) return 0;
  const controllers = [...set];
  for (const controller of controllers) controller.abort(new AudioCancelledError());
  return controllers.length;
}

/** Resolves true as soon as `done()` is, polling every `intervalMs`, or false once `timeoutMs` has passed. */
export async function waitUntil(
  done: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Rejects with an [AudioCancelledError] as soon as `signal` aborts; otherwise mirrors `promise`. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AudioCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AudioCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
