import { spawn } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

// Cloud TTS gives us Ogg Opus per chunk (see geminiClient.ts's streamSpeech),
// each a fully self-contained logical stream — concatenating them raw (as
// audioCache.repository.ts's chunks are cached) produces a spec-legal
// "chained" Ogg bitstream (multiple BOS/EOS logical streams back to back).
// That's valid Ogg, but confirmed empirically against a real device that
// ExoPlayer's OggExtractor doesn't follow a chain past its first logical
// stream — it decodes the first chunk's Opus audio fine, then just stops.
// The codec (Opus) was never the problem; chaining is the narrow, mostly
// obscure Ogg feature that's under-supported. The fix: remux the
// concatenated chunks into a single, non-chained Ogg stream (`-c:a copy` —
// container-level repaging only, no re-encode, no quality/size loss) before
// serving, so the client only ever sees one logical stream with one BOS.
const REMUX_ARGS = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "ogg",
  "-i",
  "pipe:0",
  "-map",
  "0:a",
  "-c:a",
  "copy",
  "-f",
  "ogg",
];

export interface ChainedOggRemuxer {
  /** Feed the next slice of (possibly chained) Ogg Opus bytes. */
  write(chunk: Buffer): void;
  /** Signal that no more input is coming. */
  end(): void;
  /** ffmpeg's re-muxed, single-logical-stream Ogg output, in order. */
  readonly stdout: NodeJS.ReadableStream;
  /** Resolves when ffmpeg exits cleanly; rejects (with captured stderr) otherwise. */
  readonly done: Promise<void>;
  /** Kills the underlying process — call when the consumer disconnects early. */
  destroy(): void;
}

/**
 * Wraps a single `ffmpeg` child process that remuxes a live-fed, chained Ogg
 * Opus byte stream into one continuous logical Ogg stream as bytes arrive.
 * Confirmed empirically that this flushes progressively — first output
 * bytes land within milliseconds of the first input write, not buffered
 * until stdin closes — which is what makes it safe to sit between our
 * existing per-chunk TTS relay and the HTTP response without adding real
 * latency.
 */
export function createChainedOggRemuxer(): ChainedOggRemuxer {
  const proc = spawn(ffmpeg.path, [...REMUX_ARGS, "pipe:1"], {
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
 * One-shot remux of a complete, in-memory chained Ogg Opus buffer (the
 * concatenation of every cached TTS chunk for a finished episode, or of a
 * `?t=`-resumed suffix of them) into a single continuous, non-chained Ogg
 * stream. Unlike WebM/Matroska, Ogg has no separate seek index (Cues) to
 * build — players bisect-search directly on page granule positions — so a
 * plain pipe-based remux is enough; no seekable-output trick needed here.
 */
export async function remuxChainedOggBuffer(input: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(ffmpeg.path, [...REMUX_ARGS, "pipe:1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parts: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => parts.push(d));
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(parts));
      else reject(new Error(`ffmpeg remux exited with code ${code}: ${stderr.slice(0, 2000)}`));
    });
    proc.stdin.end(input);
  });
}
