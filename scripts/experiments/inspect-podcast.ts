import { getPodcast } from "../../src/data/podcast.repository";
import { listSources } from "../../src/data/source.repository";
import { listEpisodes } from "../../src/data/episode.repository";

const PODCAST_ID = process.argv[2] ?? "a5111d8a-8fa1-4407-9adf-c9fde670f0da";

async function main() {
  const podcast = await getPodcast(PODCAST_ID);
  if (!podcast) throw new Error(`Podcast ${PODCAST_ID} not found`);
  console.log("=== Podcast ===");
  console.log(JSON.stringify(podcast, null, 2));

  const sources = await listSources(PODCAST_ID);
  console.log("\n=== Sources ===");
  for (const s of sources) {
    console.log(`- ${s.id} | ${s.title} | ${s.contents.length} chars | ${s.sourceType}`);
  }

  const episodes = await listEpisodes(PODCAST_ID);
  console.log("\n=== Existing Episodes ===");
  for (const e of episodes) {
    console.log(`- ${e.id} | ${e.title} | status=${e.status} | length=${e.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
