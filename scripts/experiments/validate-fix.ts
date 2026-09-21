/**
 * Throwaway validation script (not part of the app) — exercises the real
 * pipeline against podcast a5111d8a-8fa1-4407-9adf-c9fde670f0da to confirm:
 * 1) the episode wizard offers a 2-episode split for a source too big for a
 *    short target, and 2) script generation for each part completes without
 *    the Unicode label-matching crash, using first-name-only labels.
 *
 * Real, billed Gemini API calls. Run with:
 *   FIREBASE_PROJECT_ID=ai-audio-book FIREBASE_SERVICE_ACCOUNT_PATH=/root/credentials/service-account.json \
 *   FIREBASE_STORAGE_BUCKET=ai-audio-book-podcast-audio FIRESTORE_DATABASE_ID=podcasts \
 *   npx tsx scripts/experiments/validate-fix.ts
 */
import { getPodcast } from "../../src/data/podcast.repository";
import { listSources } from "../../src/data/source.repository";
import { createEpisode } from "../../src/data/episode.repository";
import * as episodeWizardService from "../../src/services/episodeWizard.service";
import { runEpisodeGenerationSequence } from "../../src/services/episodeGeneration/orchestrator";
import { getEpisode } from "../../src/data/episode.repository";
import type { EpisodeCreateInput } from "../../src/schemas/episode.schema";
import type { EpisodeDraft } from "../../src/schemas/wizard.schema";

const PODCAST_ID = "a5111d8a-8fa1-4407-9adf-c9fde670f0da";

function log(step: string, detail?: unknown) {
  console.log(`\n=== ${step} ===`);
  if (detail !== undefined) console.log(JSON.stringify(detail, null, 2));
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const podcast = await getPodcast(PODCAST_ID);
  if (!podcast) throw new Error(`Podcast ${PODCAST_ID} not found`);
  log("Podcast", { title: podcast.title, hosts: podcast.hosts.map((h) => h.name) });

  const sources = await listSources(PODCAST_ID);
  log(
    "Sources",
    sources.map((s) => ({ id: s.id, title: s.title, chars: s.contents.length })),
  );

  const foundParisSource = sources.find((s) => /paris/i.test(s.title));
  if (!foundParisSource) throw new Error("No source with 'Paris' in the title found on this podcast");
  const parisSource = foundParisSource;

  log("Requesting episode wizard suggestions with length=short (should force a split)");
  const result = await episodeWizardService.generateSuggestions(
    podcast,
    [parisSource],
    "short",
    undefined,
  );
  log(
    "Suggestions",
    result.suggestions.map((s) => ({
      episodeCount: s.episodes.length,
      titles: s.episodes.map((e) => e.title),
    })),
  );

  const split = result.suggestions.find((s) => s.episodes.length === 2);
  const chosen = split ?? result.suggestions[0];
  if (!chosen) throw new Error("Wizard returned no suggestions");
  log(split ? "Using the 2-episode split suggestion" : "No split offered — using the single-episode suggestion");

  const participantHostIds = podcast.hosts.slice(0, 2).map((h) => h.id);
  const guestFallback = podcast.hosts.length >= 2 ? [] : undefined;

  function toCreateInput(draft: EpisodeDraft): EpisodeCreateInput {
    const guests = guestFallback ?? draft.guests;
    const hostIds = guests.length === 0 ? participantHostIds : [participantHostIds[0]!];
    return {
      title: draft.title,
      topics: draft.topics,
      length: "short",
      sourceIds: [parisSource.id],
      participantHostIds: hostIds,
      guests,
      productionNotes: draft.productionNotes,
    };
  }

  const episodes = [];
  for (const draft of chosen.episodes) {
    const episode = await createEpisode(PODCAST_ID, toCreateInput(draft));
    episodes.push(episode);
    log("Created episode", { id: episode.id, title: episode.title });
  }

  log("Running generation sequence (this makes real Gemini calls, may take a few minutes per episode)");
  await runEpisodeGenerationSequence(
    PODCAST_ID,
    episodes.map((e) => e.id),
  ).catch((err) => {
    console.error("Generation sequence threw:", err);
  });

  for (const ep of episodes) {
    let current = await getEpisode(PODCAST_ID, ep.id);
    while (current && (current.status === "generating" || current.status === "streamable")) {
      await sleep(4000);
      current = await getEpisode(PODCAST_ID, ep.id);
      console.log(`  [${ep.id}] status=${current?.status} progress=${JSON.stringify(current?.progress)}`);
    }
    log(`Final state for ${ep.id}`, {
      status: current?.status,
      error: current?.error,
      wordCount: current?.progress?.currentWordCount,
      transcriptPreview: current?.transcript?.slice(0, 500),
      transcriptSpeakers: current?.transcript ? [...new Set(
        current.transcript.split("\n\n").map((t) => t.match(/^([^:]+):/)?.[1]).filter(Boolean),
      )] : [],
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
