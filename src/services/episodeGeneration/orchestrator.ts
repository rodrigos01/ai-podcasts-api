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
import { AgentSession } from "./agent";
import { chunkTranscript, sealedChunksSoFar } from "./chunker";
import { condenseForAllHosts } from "./condensation.service";
import { runConversation } from "./conversationLoop";
import { generateBaseTtsPrompt } from "./producerPrompt.service";
import { selectCast, type Speaker } from "./speakerSelection";

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

    // Generated from persona/podcast/episode metadata alone, before any
    // conversation turn exists (see producerPrompt.service.ts) — this and
    // the token budget it yields are what let chunk boundaries start
    // sealing from turn 1 onward, instead of waiting for the whole
    // transcript to exist first.
    const ttsPrompt = await generateBaseTtsPrompt(podcast, episode, cast.speakers);
    const basePromptTokens = await countTokens(ttsPrompt);

    await patchEpisodeState(podcastId, episodeId, {
      ttsPrompt,
      ttsChunks: [],
      progress: { stage: "producer_prompt", targetWordRange: wordTarget },
    });

    const otherSpeakerName = (speakerId: string) =>
      cast.speakers.find((s) => s.id !== speakerId)?.name ?? "the other speaker";

    const agentsBySpeakerId: Record<string, AgentSession> = {};
    for (const speaker of cast.speakers) {
      const condensedHistory = speaker.isHost
        ? await getRecentCondensedSummariesForHost(podcastId, speaker.id, episodeId)
        : [];
      agentsBySpeakerId[speaker.id] = new AgentSession(speaker, {
        podcast,
        episode,
        sources,
        otherSpeakerName: otherSpeakerName(speaker.id),
        condensedHistory: condensedHistory.length > 0 ? condensedHistory.join("\n\n") : undefined,
      });
    }

    const conversation = await runConversation(
      cast,
      agentsBySpeakerId,
      wordTarget,
      async ({ wordCount, transcript }) => {
        // Persisted after every turn (not just at the end) so a crash or
        // restart mid-conversation loses at most the in-flight turn, not
        // the whole episode's progress. Chunk boundaries are sealed
        // incrementally in the same patch — sealedChunksSoFar drops the
        // still-growing trailing chunk, so every chunk written here is
        // final and safe for /stream to generate audio for immediately,
        // even while the conversation is still going.
        await patchEpisodeState(podcastId, episodeId, {
          transcript,
          ttsChunks: sealedChunksSoFar(transcript, basePromptTokens),
          progress: { stage: "conversation", currentWordCount: wordCount, targetWordRange: wordTarget },
        });
      },
    );

    const ttsChunks = chunkTranscript(conversation.transcript, basePromptTokens);

    await patchEpisodeState(podcastId, episodeId, {
      transcript: conversation.transcript,
      ttsChunks,
      progress: {
        stage: "chunking",
        currentWordCount: conversation.finalWordCount,
        targetWordRange: wordTarget,
      },
    });

    const participatingHosts = hosts;
    const condensedSummaries =
      participatingHosts.length > 0
        ? await condenseForAllHosts(participatingHosts, conversation.transcript)
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
