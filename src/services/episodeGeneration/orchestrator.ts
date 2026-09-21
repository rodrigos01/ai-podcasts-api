import { countTokens } from "../../llm/geminiClient";
import { LENGTH_RANGES } from "../../constants/lengthRanges";
import {
  getEpisode,
  getRecentCondensedSummariesForHost,
  patchEpisodeState,
} from "../../data/episode.repository";
import { getPodcast } from "../../data/podcast.repository";
import { getSource } from "../../data/source.repository";
import type { Person } from "../../schemas/person.schema";
import { chunkTranscript } from "./chunker";
import { condenseForAllHosts } from "./condensation.service";
import { generateBaseTtsPrompt } from "./producerPrompt.service";
import { generateEpisodeScript } from "./scriptGeneration.service";
import { selectCast } from "./speakerSelection";

export async function runEpisodeGeneration(podcastId: string, episodeId: string): Promise<void> {
  try {
    const podcast = await getPodcast(podcastId);
    if (!podcast) throw new Error(`Podcast ${podcastId} not found`);
    const episode = await getEpisode(podcastId, episodeId);
    if (!episode) throw new Error(`Episode ${episodeId} not found`);

    const hosts = podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id));
    const guests: Person[] = episode.guests;
    const cast = selectCast(hosts, guests);

    const sources = (
      await Promise.all(episode.sourceIds.map((id) => getSource(podcastId, id)))
    ).filter((s): s is NonNullable<typeof s> => s !== null);

    const wordTarget = LENGTH_RANGES[episode.length];

    await patchEpisodeState(podcastId, episodeId, {
      progress: { stage: "kickoff", currentWordCount: 0, targetWordRange: wordTarget },
    });

    // Condensed continuity is fetched once up front for both hosts (a guest
    // never has one) — the single script-writing call below needs both
    // speakers' histories in the same prompt, unlike the old per-agent
    // pipeline where each independent AgentSession fetched only its own.
    const condensedHistoryBySpeakerId = new Map<string, string>();
    for (const speaker of cast.speakers) {
      if (!speaker.isHost) continue;
      const history = await getRecentCondensedSummariesForHost(podcastId, speaker.id, episodeId);
      if (history.length > 0) condensedHistoryBySpeakerId.set(speaker.id, history.join("\n\n"));
    }

    // Generated from persona/podcast/episode metadata alone — never needed
    // the transcript.
    const ttsPrompt = await generateBaseTtsPrompt(podcast, episode, cast.speakers);
    const basePromptTokens = await countTokens(ttsPrompt);

    await patchEpisodeState(podcastId, episodeId, {
      ttsPrompt,
      ttsChunks: [],
      progress: { stage: "producer_prompt", targetWordRange: wordTarget },
    });

    await patchEpisodeState(podcastId, episodeId, {
      progress: { stage: "conversation", targetWordRange: wordTarget },
    });

    // A single LLM call writes the whole episode's script itself — see
    // AGENTS.md's migration note for why this replaced the old per-turn,
    // two-independent-agent conversation loop. Unlike that loop, this
    // doesn't persist progress incrementally: nothing is written until the
    // whole script comes back, so a crash mid-call loses the whole
    // not-yet-persisted episode (recoverable via /regenerate), not just an
    // in-flight turn.
    const script = await generateEpisodeScript(
      cast,
      { podcast, episode, sources, condensedHistoryBySpeakerId },
      wordTarget,
    );

    const ttsChunks = chunkTranscript(script.transcript, basePromptTokens);

    await patchEpisodeState(podcastId, episodeId, {
      transcript: script.transcript,
      ttsChunks,
      status: "streamable",
      progress: {
        stage: "chunking",
        currentWordCount: script.wordCount,
        targetWordRange: wordTarget,
      },
    });

    const participatingHosts = hosts;
    const condensedSummaries =
      participatingHosts.length > 0
        ? await condenseForAllHosts(participatingHosts, script.transcript)
        : {};

    await patchEpisodeState(podcastId, episodeId, {
      condensedSummaries,
      status: "ready",
      progress: { stage: "done", targetWordRange: wordTarget },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await patchEpisodeState(podcastId, episodeId, { status: "failed", error: message }).catch(
      (patchErr) => {
        console.error(`Failed to mark episode ${podcastId}/${episodeId} as failed:`, patchErr);
      },
    );
    throw err;
  }
}
