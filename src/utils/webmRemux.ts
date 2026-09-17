import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

// Cloud TTS gives us Ogg Opus (see geminiClient.ts's streamSpeech) — great
// for compression, but Android's stock media stack is unreliable playing it
// back, especially progressively over HTTP. The audio codec (Opus) is fine
// everywhere; it's specifically the Ogg *container* that's the problem. The
// fix is a container remux (Ogg -> WebM), not a re-encode: `-c:a copy` just
// repackages the same Opus packets, so there's no quality loss and no CPU
// cost anywhere near real transcoding.
const REMUX_INPUT_ARGS = ["-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0"];
const REMUX_OUTPUT_ARGS = ["-map", "0:a", "-c:a", "copy", "-f", "webm"];

export interface OggToWebmRemuxer {
  /** Feed the next slice of (possibly chained) Ogg Opus bytes. */
  write(chunk: Buffer): void;
  /** Signal that no more input is coming. */
  end(): void;
  /** ffmpeg's remuxed WebM output, in order. */
  readonly stdout: NodeJS.ReadableStream;
  /** Resolves when ffmpeg exits cleanly; rejects (with captured stderr) otherwise. */
  readonly done: Promise<void>;
  /** Kills the underlying process — call when the consumer disconnects early. */
  destroy(): void;
}

/**
 * Wraps a single `ffmpeg` child process that remuxes a live-fed, chained Ogg
 * Opus byte stream into WebM as bytes arrive. Confirmed empirically (not
 * assumed from docs) that this flushes progressively — first output bytes
 * land within milliseconds of the first input write, not buffered until
 * stdin closes — which is what makes it safe to sit between our existing
 * per-chunk TTS relay and the HTTP response without adding real latency.
 * Also confirmed: identical input reliably produces byte-identical output
 * across separate runs (pure stream-copy remux, no encoder state to vary).
 *
 * Output goes to a pipe (`pipe:1`), which is non-seekable — ffmpeg can't
 * rewind it to patch in a Cues/SeekHead index afterward, so this produces a
 * WebM stream with no seek index. Expected and fine here: this is only used
 * for the still-generating case, where specs.md already disallows scrubbing
 * ahead of what's been generated. See remuxOggBufferToWebmFile for the
 * fully-indexed variant used once an episode is completely cached.
 */
export function createOggToWebmRemuxer(): OggToWebmRemuxer {
  const proc = spawn(ffmpeg.path, [...REMUX_INPUT_ARGS, ...REMUX_OUTPUT_ARGS, "pipe:1"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg remux exited with code ${code}: ${stderr.slice(0, 2000)}`));
    });
  });

  return {
    write: (chunk) => {
      if (!proc.stdin.destroyed) proc.stdin.write(chunk);
    },
    end: () => {
      if (!proc.stdin.destroyed) proc.stdin.end();
    },
    stdout: proc.stdout,
    done,
    destroy: () => {
      proc.stdout.destroy();
      proc.stdin.destroy();
      proc.kill("SIGKILL");
    },
  };
}

/**
 * One-shot remux of a complete, in-memory Ogg Opus buffer (the concatenation
 * of every cached TTS chunk for a finished episode) into a single
 * well-formed WebM file. Unlike createOggToWebmRemuxer, this writes ffmpeg's
 * output to a real temp file rather than a pipe — a seekable output lets
 * ffmpeg go back and write a proper Cues/SeekHead index, giving precise
 * seeking on the finished artifact. This is the file meant to be served
 * directly (and, eventually, fronted by a CDN), so it should be a normal,
 * fully-indexed WebM rather than the streaming-mode variant.
 */
export async function remuxOggBufferToWebmFile(input: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "webm-remux-"));
  const outputPath = join(dir, "out.webm");
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg.path, [...REMUX_INPUT_ARGS, ...REMUX_OUTPUT_ARGS, "-y", outputPath], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg remux exited with code ${code}: ${stderr.slice(0, 2000)}`));
      });
      proc.stdin.end(input);
    });
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
