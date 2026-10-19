/**
 * Adds an arm to an A/B test: a copy of `templatePodcast` (new host ids, copied
 * sources) under the same owner, plus a copy of `sourcePodcast`'s episodes with
 * no transcripts/audio/lease, `status: "generating"`, source and host ids
 * translated to the arm's own, the original order kept (strictly increasing
 * createdAt) and `startsAfterEpisodeId` links preserved. Guests' voices are
 * cleared. Idempotent: an arm found by owner + title that already has episodes
 * is left alone.
 *
 *   npx tsx .claude/skills/prompt-ab-test/scripts/setup-arm.ts <sourcePodcastId> <templatePodcastId> "<title>" ['{"someFlag":"x"}']
 *
 * The optional JSON is merged into the arm's podcast doc: the per-arm switches
 * the code under test reads (see SKILL.md). Reuse the template's own title
 * pattern, "... (Test X)", so logs can name the arm.
 */
import { randomUUID } from "node:crypto";
import { firestore } from "../../../../src/config/firebase";
import type { Episode } from "../../../../src/schemas/episode.schema";
import type { Podcast } from "../../../../src/schemas/podcast.schema";
import type { Source } from "../../../../src/schemas/source.schema";
import { NO_VOICE } from "../../../../src/utils/voiceDecision";

const podcasts = firestore.collection("podcasts");

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`unknown ${what}`);
  return value;
}

async function main() {
  const [sourceId, templateId, title, extrasArg] = process.argv.slice(2);
  if (!sourceId || !templateId || !title) {
    throw new Error('usage: setup-arm.ts <sourcePodcastId> <templatePodcastId> "<title>" [extrasJson]');
  }
  const extras = extrasArg ? (JSON.parse(extrasArg) as Record<string, unknown>) : {};

  const source = (await podcasts.doc(sourceId).get()).data() as Podcast;
  const template = (await podcasts.doc(templateId).get()).data() as Podcast;
  const sourceSources = (await podcasts.doc(sourceId).collection("sources").get()).docs.map((d) => d.data() as Source);
  const sourceEpisodes = (await podcasts.doc(sourceId).collection("episodes").get()).docs
    .map((d) => d.data() as Episode)
    .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));

  let arm = (await podcasts.where("ownerId", "==", template.ownerId).where("title", "==", title).get()).docs[0]?.data() as
    | Podcast
    | undefined;
  if (!arm) {
    const now = Date.now();
    arm = {
      ...template,
      id: randomUUID(),
      title,
      ...extras,
      // Hosts keep the template's designed voice ids, so deleting an arm podcast deletes a voice its siblings use.
      hosts: template.hosts.map((h) => ({ ...h, id: randomUUID() })),
      createdAt: now,
      updatedAt: now,
    };
    await podcasts.doc(arm.id).set(arm);
    for (const s of (await podcasts.doc(templateId).collection("sources").get()).docs.map((d) => d.data() as Source)) {
      const id = randomUUID();
      await podcasts.doc(arm.id).collection("sources").doc(id).set({ ...s, id });
    }
    console.log(`Created "${title}": ${arm.id}`);
  }

  const ref = podcasts.doc(arm.id);
  if (!(await ref.collection("episodes").limit(1).get()).empty) {
    console.log(`"${title}": already has episodes, skipping`);
    return;
  }
  // Sources are matched on title, hosts on index.
  const armSources = (await ref.collection("sources").get()).docs.map((d) => d.data() as Source);
  const sourceIdMap = new Map(
    sourceSources.map((s) => [s.id, need(armSources.find((t) => t.title === s.title)?.id, `source "${s.title}"`)]),
  );
  const hostIdMap = new Map(source.hosts.map((h, i) => [h.id, need(arm.hosts[i]?.id, `host ${i}`)]));
  const episodeIdMap = new Map(sourceEpisodes.map((e) => [e.id, randomUUID()]));
  let lastCreatedAt = 0;
  for (const e of sourceEpisodes) {
    const createdAt = Math.max(e.createdAt, lastCreatedAt + 1);
    lastCreatedAt = createdAt;
    const copy: Episode = {
      id: need(episodeIdMap.get(e.id), "episode"),
      title: e.title,
      topics: e.topics,
      length: e.length,
      sourceIds: e.sourceIds.map((id) => need(sourceIdMap.get(id), `source ${id}`)),
      participantHostIds: e.participantHostIds.map((id) => need(hostIdMap.get(id), `host ${id}`)),
      guests: e.guests.map((g) => ({ ...g, id: randomUUID(), ...NO_VOICE })),
      ...(e.productionNotes ? { productionNotes: e.productionNotes } : {}),
      status: "generating",
      progress: null,
      transcript: null,
      ttsChunks: null,
      generatedAudioSeconds: 0,
      audioComplete: false,
      ...(e.startsAfterEpisodeId ? { startsAfterEpisodeId: need(episodeIdMap.get(e.startsAfterEpisodeId), "episode") } : {}),
      error: null,
      createdAt,
      updatedAt: Date.now(),
    };
    await ref.collection("episodes").doc(copy.id).set(copy);
  }
  console.log(`"${title}" (${arm.id}): copied ${sourceEpisodes.length} episodes`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
