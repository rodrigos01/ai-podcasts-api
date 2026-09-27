/**
 * One-time infra setup for the Gemini 3.8 Flash TTS migration's storage
 * TTLs — NOT run automatically by anything, and not applied to the
 * production bucket as part of this migration's code changes. A human
 * needs to review and run this deliberately (see AGENTS.md).
 *
 * GCS has no true per-object TTL. The closest mechanism is a bucket-level
 * Object Lifecycle rule keyed on `daysSinceCustomTime`, paired with the
 * `customTime` object metadata this app already sets at write time (see
 * storage/audioCache.repository.ts's putInProgressAudio/putFinalAudio) —
 * so each object's TTL clock starts from when it was actually (re)written,
 * not just its underlying GCS creation time. This script adds two rules,
 * scoped by path prefix so they only ever touch this app's own audio
 * objects:
 *
 *   - podcasts/*\/episodes/*\/audio/in-progress.wav — deleted 7 days after
 *     its last write (temporary, in-progress synthesis snapshots).
 *   - podcasts/*\/episodes/*\/audio/final.ogg — deleted 90 days after its
 *     last write (the finished, delivered episode audio).
 *
 * GCS lifecycle `matchesPrefix` only supports fixed string prefixes, not
 * wildcards/globs — so this can't scope to "any episode's in-progress.wav"
 * with a single rule the way a glob would. Since every episode's audio
 * lives under a `.../audio/` folder either way, these rules instead match
 * on the fixed suffix-bearing prefix `podcasts/` combined with a
 * `matchesSuffix` on the filename, which GCS does support alongside
 * `matchesPrefix` — the pair together correctly scopes to "any
 * in-progress.wav under podcasts/" without touching final.ogg files or
 * anything outside podcasts/, and vice versa.
 *
 * Usage: `npx tsx scripts/configure-audio-storage-lifecycle.ts` (reads the
 * same .env / credentials as the app itself — see config/firebase.ts).
 * Idempotent-ish: re-running calls `addLifecycleRule` again, which can
 * create a duplicate rule rather than replacing it — check the bucket's
 * current lifecycle config (e.g. `gsutil lifecycle get gs://<bucket>`)
 * before re-running if you're not sure whether this has already been
 * applied.
 */
import { storageBucket } from "../src/config/firebase";

const IN_PROGRESS_TTL_DAYS = 7;
const FINAL_TTL_DAYS = 90;

async function main() {
  console.log(`Bucket: ${storageBucket.name}`);

  await storageBucket.addLifecycleRule({
    action: { type: "Delete" },
    condition: {
      daysSinceCustomTime: IN_PROGRESS_TTL_DAYS,
      matchesPrefix: ["podcasts/"],
      matchesSuffix: ["/audio/in-progress.wav"],
    },
  });
  console.log(`Added rule: delete .../audio/in-progress.wav objects ${IN_PROGRESS_TTL_DAYS} days after their last write.`);

  await storageBucket.addLifecycleRule({
    action: { type: "Delete" },
    condition: {
      daysSinceCustomTime: FINAL_TTL_DAYS,
      matchesPrefix: ["podcasts/"],
      matchesSuffix: ["/audio/final.ogg"],
    },
  });
  console.log(`Added rule: delete .../audio/final.ogg objects ${FINAL_TTL_DAYS} days after their last write.`);

  const [metadata] = await storageBucket.getMetadata();
  console.log("\nBucket's full current lifecycle config:");
  console.log(JSON.stringify(metadata.lifecycle, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
