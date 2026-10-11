/**
 * One-time infra setup for the audio storage TTL — NOT run automatically by
 * anything. A human needs to review and run this deliberately (see
 * AGENTS.md).
 *
 * GCS has no true per-object TTL. The closest mechanism is a bucket-level
 * Object Lifecycle rule keyed on `daysSinceCustomTime`, paired with the
 * `customTime` object metadata this app sets at write time (see
 * storage/audioCache.repository.ts's putCachedChunk and composeFinalAudio) —
 * so each object's TTL clock starts from when it was actually written, not
 * just its underlying GCS creation time. This script adds one rule, scoped
 * by path so it only ever touches this app's own audio objects:
 *
 *   - podcasts/**\/audio/*.aac — deleted 90 days after it was written. That
 *     is every cached chunk (`chunk-N.aac`) and the consolidated episode
 *     (`final.aac`).
 *
 * GCS lifecycle conditions only support fixed string prefixes and suffixes,
 * not globs, so the rule combines `matchesPrefix: podcasts/` with
 * `matchesSuffix: .aac`. Nothing else in the bucket ends in `.aac`.
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

const AUDIO_TTL_DAYS = 90;

async function main() {
  console.log(`Bucket: ${storageBucket.name}`);

  await storageBucket.addLifecycleRule({
    action: { type: "Delete" },
    condition: {
      daysSinceCustomTime: AUDIO_TTL_DAYS,
      matchesPrefix: ["podcasts/"],
      matchesSuffix: [".aac"],
    },
  });
  console.log(`Added rule: delete podcasts/**/*.aac objects ${AUDIO_TTL_DAYS} days after they were written.`);

  const [metadata] = await storageBucket.getMetadata();
  console.log("\nBucket's full current lifecycle config:");
  console.log(JSON.stringify(metadata.lifecycle, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
