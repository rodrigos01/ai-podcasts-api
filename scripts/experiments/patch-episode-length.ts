/**
 * Experiment utility: directly patches an episode's `length` field in
 * Firestore, bypassing episodeUpdateSchema (which deliberately excludes
 * `length` from the public update API). Used to re-target the same
 * experiment episode to the length the episode wizard itself suggested,
 * instead of creating a new episode.
 *
 * Usage: npx tsx scripts/experiments/patch-episode-length.ts <podcastId> <episodeId> <short|medium|long>
 */
import { getEpisode, patchEpisodeState } from "../../src/data/episode.repository";
import { LENGTH_RANGES, type EpisodeLength } from "../../src/constants/lengthRanges";

const PODCAST_ID = process.argv[2];
const EPISODE_ID = process.argv[3];
const LENGTH = process.argv[4] as EpisodeLength;

async function main() {
  if (!PODCAST_ID || !EPISODE_ID || !LENGTH_RANGES[LENGTH]) {
    throw new Error("Usage: patch-episode-length.ts <podcastId> <episodeId> <short|medium|long>");
  }
  const before = await getEpisode(PODCAST_ID, EPISODE_ID);
  if (!before) throw new Error(`Episode ${EPISODE_ID} not found`);
  console.log(`Current length: ${before.length} (${LENGTH_RANGES[before.length].min}-${LENGTH_RANGES[before.length].max})`);

  await patchEpisodeState(PODCAST_ID, EPISODE_ID, { length: LENGTH });

  console.log(`Patched to: ${LENGTH} (${LENGTH_RANGES[LENGTH].min}-${LENGTH_RANGES[LENGTH].max})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
