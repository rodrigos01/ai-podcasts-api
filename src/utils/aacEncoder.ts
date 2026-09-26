import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AdtsFrameAccumulator } from "./adts";

/**
 * Wraps one short-lived `ffmpeg` process encoding a single TTS chunk's raw
 * PCM (16-bit signed little-endian, mono, `sampleRateHertz` — Cloud TTS's
 * `PCM` audioEncoding, see geminiClient.ts's streamSpeech) into ADTS AAC,
 * incrementally: PCM is fed via `write()` as it arrives from Cloud TTS's
 * `streamingSynthesize`, and encoded frames are forwarded via `onFrame` as
 * soon as ffmpeg emits them — confirmed empirically (2026-09-26) that
 * ffmpeg's ADTS muxer flushes progressively as input arrives rather than
 * buffering the whole chunk, so a live listener doesn't wait for an entire
 * ~1-2 minute chunk to finish encoding before hearing it.
 *
 * One instance per chunk, by design: a persistent encoder spanning a whole
 * episode would need to stay alive across requests/days for a user resuming
 * a half-generated episode tomorrow, which doesn't fit this app's on-demand,
 * resumable generation model (see AGENTS.md). The accepted cost is a small,
 * per-chunk-boundary discontinuity from each fresh encoder's own priming/
 * lookahead — tolerable relative to keeping chunk-level cacheability and
 * cross-session/cross-instance resumability, which a persistent per-episode
 * encoder process could not provide.
 */
export class PcmToAacEncoder {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly accumulator = new AdtsFrameAccumulator();
  private readonly frames: Buffer[] = [];
  private error: Error | null = null;
  private exited = false;
  private exitWaiters: (() => void)[] = [];

  constructor(sampleRateHertz: number, bitrateKbps: number, onFrame: (frame: Buffer) => void) {
    this.child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        String(sampleRateHertz),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "aac",
        "-b:a",
        `${bitrateKbps}k`,
        "-f",
        "adts",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.child.stdout.on("data", (data: Buffer) => {
      for (const frame of this.accumulator.push(data)) {
        this.frames.push(frame);
        onFrame(frame);
      }
    });
    // loglevel=error keeps this to genuine problems, but we don't have a
    // clean structured signal from ffmpeg's stderr text — a real failure is
    // already surfaced via "error"/a non-zero "exit" below, so this is just
    // swallowed rather than parsed.
    this.child.stderr.on("data", () => {});
    this.child.on("error", (err) => {
      this.error = err;
      this.settleExit();
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      if (code !== 0 && !this.error) {
        this.error = new Error(`ffmpeg exited with code ${code}`);
      }
      this.settleExit();
    });
  }

  private settleExit(): void {
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private waitForExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  /** Feeds one more PCM delta. Throws if the encoder has already failed — see the class doc comment. */
  write(pcm: Buffer): void {
    if (this.error) throw this.error;
    if (!this.child.stdin.writableEnded) this.child.stdin.write(pcm);
  }

  /**
   * Ends input, waits for ffmpeg to flush its remaining (lookahead-delayed)
   * output and exit, and returns the whole chunk's encoded bytes. Callers
   * must not call `write` again afterward.
   */
  async finish(): Promise<Buffer> {
    if (!this.child.stdin.writableEnded) this.child.stdin.end();
    await this.waitForExit();
    if (this.error) throw this.error;
    this.accumulator.assertDrained();
    return Buffer.concat(this.frames);
  }

  /**
   * Forcefully terminates the underlying process without waiting for a
   * clean exit — used when the caller is abandoning this chunk after a
   * failure elsewhere (e.g. streamSpeech itself rejected), so ffmpeg
   * doesn't leak as an orphaned process still waiting on stdin.
   */
  kill(): void {
    if (!this.exited) this.child.kill("SIGKILL");
  }
}
