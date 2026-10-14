/**
 * One-off: adds an arm to the history-method A/B test.
 *
 * Creates (or finds, by owner + title) a copy of `templatePodcast` — hosts get
 * new ids, sources are copied — with the given `historyMethod`, then copies the
 * episodes of `sourcePodcast` into it: no transcripts/audio/lease,
 * `status: "generating"`, sourceIds and participantHostIds translated to the
 * arm's own ids, original order kept (strictly increasing createdAt) and
 * `startsAfterEpisodeId` links preserved. Idempotent: an arm that already has
 * episodes is left alone.
 *
 *   npx tsx scripts/ab-test-setup.ts <sourcePodcastId> <templatePodcastId> "<title>" <historyMethod>
 */
import { randomUUID } from "node:crypto";
import { firestore } from "../src/config/firebase";
import { historyMethodSchema, type Podcast } from "../src/schemas/podcast.schema";
import type { Episode } from "../src/schemas/episode.schema";
import type { Source } from "../src/schemas/source.schema";
import { NO_VOICE } from "../src/utils/voiceDecision";

const podcasts = firestore.collection("podcasts");

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`unknown ${what}`);
  return value;
}

async function main() {
  const [sourceId, templateId, title, methodArg] = process.argv.slice(2);
  if (!sourceId || !templateId || !title || !methodArg) {
    throw new Error('usage: ab-test-setup.ts <sourcePodcastId> <templatePodcastId> "<title>" <historyMethod>');
  }
  const historyMethod = historyMethodSchema.parse(methodArg);

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
      historyMethod,
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
  } else if (arm.historyMethod !== historyMethod) {
    throw new Error(`"${title}" exists with historyMethod ${arm.historyMethod}`);
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
      ...(e.startsAfterEpisodeId
        ? { startsAfterEpisodeId: need(episodeIdMap.get(e.startsAfterEpisodeId), "episode") }
        : {}),
      error: null,
      createdAt,
      updatedAt: Date.now(),
    };
    await ref.collection("episodes").doc(copy.id).set(copy);
  }
  console.log(`"${title}" (${arm.id}): copied ${sourceEpisodes.length} episodes`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
