/**
 * One-off: sets up the interaction-context A/B test.
 *
 *   A = an existing copy of the source podcast (manual history; flag off)
 *   B = a second copy under the same owner, flag `useInteractionContext: true`
 *
 * Copies the source podcast's episodes into both — no transcripts/audio/lease,
 * `status: "generating"`, sourceIds and participantHostIds translated to each
 * copy's own ids — keeping the original's order (strictly increasing createdAt).
 * Idempotent: B is found by title, and a copy that already has episodes is left alone.
 *
 *   npx tsx scripts/ab-test-setup.ts <sourcePodcastId> <testAPodcastId>
 */
import { randomUUID } from "node:crypto";
import { firestore } from "../src/config/firebase";
import type { Episode } from "../src/schemas/episode.schema";
import type { Podcast } from "../src/schemas/podcast.schema";
import type { Source } from "../src/schemas/source.schema";
import { NO_VOICE } from "../src/utils/voiceDecision";

const B_TITLE = "Armchair Travel Diaries (Test B)";
const podcasts = firestore.collection("podcasts");

async function main() {
  const [sourceId, aId] = process.argv.slice(2);
  if (!sourceId || !aId) throw new Error("usage: ab-test-setup.ts <sourcePodcastId> <testAPodcastId>");

  const source = (await podcasts.doc(sourceId).get()).data() as Podcast;
  const a = (await podcasts.doc(aId).get()).data() as Podcast;
  const sourceSources = (await podcasts.doc(sourceId).collection("sources").get()).docs.map((d) => d.data() as Source);
  const sourceEpisodes = (await podcasts.doc(sourceId).collection("episodes").get()).docs
    .map((d) => d.data() as Episode)
    .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));

  // B: same owner as A, a copy of A (hosts get new ids; the designed voice id is shared).
  let b = (await podcasts.where("ownerId", "==", a.ownerId).where("title", "==", B_TITLE).get()).docs[0]?.data() as
    | Podcast
    | undefined;
  if (!b) {
    const now = Date.now();
    b = {
      ...a,
      id: randomUUID(),
      title: B_TITLE,
      useInteractionContext: true,
      hosts: a.hosts.map((h) => ({ ...h, id: randomUUID() })),
      createdAt: now,
      updatedAt: now,
    };
    await podcasts.doc(b.id).set(b);
    for (const s of (await podcasts.doc(aId).collection("sources").get()).docs.map((d) => d.data() as Source)) {
      const id = randomUUID();
      await podcasts.doc(b.id).collection("sources").doc(id).set({ ...s, id });
    }
    console.log(`Created B: ${b.id}`);
  }
  await podcasts.doc(aId).update({ useInteractionContext: false });

  for (const target of [a, b]) {
    const ref = podcasts.doc(target.id);
    if (!(await ref.collection("episodes").limit(1).get()).empty) {
      console.log(`${target.title}: already has episodes, skipping`);
      continue;
    }
    // Translate by position/title: sources are matched on title, hosts on index.
    const targetSources = (await ref.collection("sources").get()).docs.map((d) => d.data() as Source);
    const sourceIdMap = new Map(
      sourceSources.map((s) => {
        const match = targetSources.find((t) => t.title === s.title);
        if (!match) throw new Error(`${target.title} has no source titled "${s.title}"`);
        return [s.id, match.id];
      }),
    );
    const hostIdMap = new Map(source.hosts.map((h, i) => [h.id, target.hosts[i]!.id]));
    const episodeIdMap = new Map(sourceEpisodes.map((e) => [e.id, randomUUID()]));
    let lastCreatedAt = 0;
    for (const e of sourceEpisodes) {
      const createdAt = Math.max(e.createdAt, lastCreatedAt + 1);
      lastCreatedAt = createdAt;
      const copy: Episode = {
        id: episodeIdMap.get(e.id)!,
        title: e.title,
        topics: e.topics,
        length: e.length,
        sourceIds: e.sourceIds.map((id) => sourceIdMap.get(id) ?? (() => { throw new Error(`unknown source ${id}`); })()),
        participantHostIds: e.participantHostIds.map((id) => hostIdMap.get(id) ?? (() => { throw new Error(`unknown host ${id}`); })()),
        guests: e.guests.map((g) => ({ ...g, id: randomUUID(), ...NO_VOICE })),
        ...(e.productionNotes ? { productionNotes: e.productionNotes } : {}),
        status: "generating",
        progress: null,
        transcript: null,
        ttsChunks: null,
        generatedAudioSeconds: 0,
        audioComplete: false,
        ...(e.startsAfterEpisodeId ? { startsAfterEpisodeId: episodeIdMap.get(e.startsAfterEpisodeId)! } : {}),
        error: null,
        createdAt: createdAt,
        updatedAt: Date.now(),
      };
      await ref.collection("episodes").doc(copy.id).set(copy);
    }
    console.log(`${target.title} (${target.id}): copied ${sourceEpisodes.length} episodes`);
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
