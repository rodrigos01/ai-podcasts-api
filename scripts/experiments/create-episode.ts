import { getPodcast } from "../../src/data/podcast.repository";
import { getSource, listSources } from "../../src/data/source.repository";
import { createEpisode } from "../../src/data/episode.repository";
import { generateDraft } from "../../src/services/episodeWizard.service";
import type { EpisodeCreateInput } from "../../src/schemas/episode.schema";

const PODCAST_ID = process.argv[2] ?? "a5111d8a-8fa1-4407-9adf-c9fde670f0da";

async function main() {
  const podcast = await getPodcast(PODCAST_ID);
  if (!podcast) throw new Error(`Podcast ${PODCAST_ID} not found`);

  const sources = await listSources(PODCAST_ID);
  // Use the Paris source only — this show's format is one destination +
  // one local guest per episode (see podcast.structure), and mixing two
  // cities' diaries into one episode would fight that format.
  const paris = sources.find((s) => s.title.toLowerCase().includes("paris"));
  if (!paris) throw new Error("Paris source not found");

  console.log("Generating episode draft via episode wizard (real LLM call)...");
  const draft = await generateDraft(podcast, [paris]);
  console.log(JSON.stringify(draft, null, 2));

  if (!draft.guests || draft.guests.length !== 1) {
    throw new Error(
      `Expected exactly 1 guest from the wizard draft (podcast has 1 host), got ${draft.guests?.length ?? 0}`,
    );
  }

  const input: EpisodeCreateInput = {
    title: draft.title,
    topics: draft.topics,
    length: "short",
    sourceIds: [paris.id],
    participantHostIds: podcast.hosts.map((h) => h.id),
    guests: draft.guests,
    productionNotes: draft.productionNotes,
  };

  const episode = await createEpisode(PODCAST_ID, input);
  console.log("\n=== Created Episode ===");
  console.log(JSON.stringify(episode, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
