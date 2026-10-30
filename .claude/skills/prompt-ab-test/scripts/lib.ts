/**
 * Shared helpers for the prompt/model A/B harness (see ../SKILL.md). Run from
 * the repo root with `npx tsx .claude/skills/prompt-ab-test/scripts/<script>.ts`;
 * the env vars the skill lists must be set (config/env.ts exits without them).
 *
 * `generate` mirrors orchestrator.ts's runEpisodeGeneration, minus voice
 * resolution (billed Voice Design calls that leave orphaned voices behind) and
 * minus the dependents chain (the harness sequences episodes itself). If the
 * experiment changes what the orchestrator passes to generateEpisodeScript,
 * change `generate` below the same way — or, better, move that logic into
 * one function in src/ that both call.
 */
import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { MAX_HISTORY_EPISODES } from "../../../../src/constants/episodeHistory";
import { GENERATION_HEARTBEAT_INTERVAL_MS } from "../../../../src/constants/generationLease";
import { LENGTH_RANGES } from "../../../../src/constants/lengthRanges";
import {
  acquireGenerationLease,
  getEpisode,
  getPriorEpisodes,
  heartbeatGenerationLease,
  listEpisodes,
  patchEpisodeStateAsOwner,
  releaseGenerationLease,
} from "../../../../src/data/episode.repository";
import { firestore } from "../../../../src/config/firebase";
import { getPodcast } from "../../../../src/data/podcast.repository";
import { getSource } from "../../../../src/data/source.repository";
import type { Episode } from "../../../../src/schemas/episode.schema";
import type { Podcast } from "../../../../src/schemas/podcast.schema";
import type { Source } from "../../../../src/schemas/source.schema";
import { NO_VOICE } from "../../../../src/utils/voiceDecision";
import { chunkTranscript } from "../../../../src/services/episodeGeneration/chunker";
import { generateEpisodeScript, type EpisodeScript } from "../../../../src/services/episodeGeneration/scriptGeneration.service";
import { generateSuggestions } from "../../../../src/services/episodeWizard.service";
import { withContinuity } from "../../../../src/services/episodeGeneration/continuity";
import { selectCast } from "../../../../src/services/episodeGeneration/speakerSelection";

export const log = (label: string, msg: string) => console.log(`[${new Date().toISOString()}] ${label}: ${msg}`);

/** An arm's episodes in series order (createdAt, then id), the order history is built in. */
export async function inSeriesOrder(podcastId: string): Promise<Episode[]> {
  return (await listEpisodes(podcastId)).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** "Armchair Travel Diaries (Test D)" -> "Armchair Travel Diaries". */
export const baseTitle = (title: string) => title.replace(/\s*\(Test \w+\)\s*$/, "");

/** "Armchair Travel Diaries (Test D)" -> "D", for log lines. */
export async function armLabel(podcastId: string): Promise<string> {
  return (await getPodcast(podcastId))?.title.match(/\(Test (\w+)\)/)?.[1] ?? podcastId.slice(0, 6);
}

/** The fields a finished script writes, as orchestrator.ts does. */
export const ready = (script: EpisodeScript): Partial<Episode> => ({
  transcript: script.transcript,
  ttsChunks: chunkTranscript(script.transcript),
  interactionId: script.interactionId,
  status: "ready",
  progress: { stage: "done", currentWordCount: script.wordCount },
  error: null,
});

/** Writes `fields` to an episode nothing else is generating (takes and releases its lease). */
export async function writeEpisode(podcastId: string, episodeId: string, fields: Partial<Episode>): Promise<void> {
  const owner = randomUUID();
  if (!(await acquireGenerationLease(podcastId, episodeId, owner))) throw new Error("lease held elsewhere");
  try {
    await patchEpisodeStateAsOwner(podcastId, episodeId, owner, fields);
  } finally {
    await releaseGenerationLease(podcastId, episodeId, owner);
  }
}

/**
 * Generates one episode's script and saves it. Holds the generation lease the
 * whole time so a deployed server whose status poll finds a "generating"
 * episode with no lease doesn't start a second run. Marks the episode failed
 * (and rethrows) if the script call fails.
 */
export async function generate(label: string, podcastId: string, episodeId: string): Promise<EpisodeScript> {
  const owner = randomUUID();
  if (!(await acquireGenerationLease(podcastId, episodeId, owner))) throw new Error(`${label}: lease held elsewhere`);
  const heartbeat = setInterval(
    () => heartbeatGenerationLease(podcastId, episodeId, owner).catch(() => {}),
    GENERATION_HEARTBEAT_INTERVAL_MS,
  );
  const patch = (f: Partial<Episode>) => patchEpisodeStateAsOwner(podcastId, episodeId, owner, f);
  try {
    const stored = (await getPodcast(podcastId))!;
    // Arms are told apart by a "(Test X)" suffix on the title, but the system instruction
    // names the show: generate under the base title so every arm sees the same prompt.
    const podcast = { ...stored, title: baseTitle(stored.title) };
    const episode = (await getEpisode(podcastId, episodeId))!;
    const cast = selectCast(podcast.hosts.filter((h) => episode.participantHostIds.includes(h.id)), episode.guests);
    const sources = (await Promise.all(episode.sourceIds.map((id) => getSource(podcastId, id)))).filter((s) => s !== null);
    const wordTarget = LENGTH_RANGES[episode.length];
    const prior = await getPriorEpisodes(podcast.id, { id: episode.id, createdAt: episode.createdAt }, MAX_HISTORY_EPISODES);
    const t0 = Date.now();
    const script = await withContinuity(podcast, prior, (c) => {
      log(label, c.previousInteractionId ? `start (chained from ${c.previousInteractionId})` : `start (${c.previousEpisodes.length} prior transcripts)`);
      return generateEpisodeScript(cast, { podcast, episode, sources, previousEpisodes: c.previousEpisodes }, wordTarget, c.previousInteractionId);
    });
    await patch(ready(script));
    log(label, `done: ${script.wordCount} words (target ${wordTarget.min}-${wordTarget.max}) in ${Math.round((Date.now() - t0) / 1000)}s`);
    return script;
  } catch (err) {
    await patch({ status: "failed", error: err instanceof Error ? err.message : String(err) }).catch(() => {});
    throw err;
  } finally {
    clearInterval(heartbeat);
    await releaseGenerationLease(podcastId, episodeId, owner).catch(() => {});
  }
}

/**
 * Re-drafts episode `index` (0-based) of each arm the way the app does, through the
 * episode wizard's draft call, and writes the draft's title, topics, production
 * notes and guest onto the arm's episode (sources, length and host stay as they
 * are: they are inputs to the request). `prompt` is the user's own instruction for
 * the draft call (the original episode's production notes in the history test), if any.
 * Arms whose history is identical (same earlier transcripts) get one shared draft;
 * the others draft separately. Only the first suggestion's first episode is used,
 * and the shape the wizard chose is logged.
 */
export async function redraftEpisode(armIds: string[], index: number, prompt: string | undefined): Promise<void> {
  const groups = new Map<string, { armId: string; label: string }[]>();
  for (const armId of armIds) {
    const episode = (await inSeriesOrder(armId))[index]!;
    if (episode.transcript) continue; // already generated: leave its draft alone
    const prior = await getPriorEpisodes(armId, { id: episode.id, createdAt: episode.createdAt }, MAX_HISTORY_EPISODES);
    const mode = (await getPodcast(armId))?.useInteractionContext !== false ? `chain:${prior[prior.length - 1]?.episode.interactionId}` : "transcripts";
    // Arms with different extra instructions must draft separately: the drafter reads them.
    const extra = (await getPodcast(armId))?.extraInstructions ?? "";
    const key = createHash("sha1").update(mode + extra + prior.map((p) => p.episode.transcript).join("\n---\n")).digest("hex");
    groups.set(key, [...(groups.get(key) ?? []), { armId, label: await armLabel(armId) }]);
  }
  for (const members of groups.values()) {
    const lead = members[0]!;
    const stored = (await getPodcast(lead.armId))!;
    const podcast = { ...stored, title: baseTitle(stored.title) };
    const episode = (await inSeriesOrder(lead.armId))[index]!;
    const sources = (await Promise.all(episode.sourceIds.map((id) => getSource(lead.armId, id)))).filter((s) => s !== null);
    const previousEpisodes = await getPriorEpisodes(lead.armId, { id: episode.id, createdAt: episode.createdAt }, MAX_HISTORY_EPISODES);
    const result = await withContinuity(podcast, previousEpisodes, (c) =>
      generateSuggestions(podcast, sources, episode.length, c.previousEpisodes, prompt, c.previousInteractionId),
    );
    const draft = result.suggestions[0]!.episodes[0]!;
    const shape = result.suggestions.map((s) => `${s.episodes.length} ep`).join(" + ");
    log(
      members.map((m) => `${m.label}${index + 1}`).join("+"),
      `draft (${previousEpisodes.length} prior; wizard returned ${shape}) ${JSON.stringify({ title: draft.title, topics: draft.topics, productionNotes: draft.productionNotes, guest: draft.guests[0] })}`,
    );
    for (const member of members) {
      const target = (await inSeriesOrder(member.armId))[index]!;
      await firestore
        .collection("podcasts")
        .doc(member.armId)
        .collection("episodes")
        .doc(target.id)
        .update({
          title: draft.title,
          topics: draft.topics,
          productionNotes: draft.productionNotes ?? FieldValue.delete(),
          guests: draft.guests.map((g) => ({ ...g, id: randomUUID(), ...NO_VOICE })),
          updatedAt: Date.now(),
        });
    }
  }
}
