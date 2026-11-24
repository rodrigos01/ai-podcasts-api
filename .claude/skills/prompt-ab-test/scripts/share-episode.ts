/**
 * Makes two arms share one episode: copies episode N's draft fields, transcript
 * and stored interaction id from one arm into the other, so both continue from
 * the same episode (as the shared episode 1 does). Use it when the arms
 * diverged on an episode you want to hold fixed, then reset-arm.ts the episodes after it.
 *
 *   npx tsx .claude/skills/prompt-ab-test/scripts/share-episode.ts <fromArmId> <toArmId> <episodeNumber>
 */
import { inSeriesOrder, writeEpisode, log } from "./lib";
import { firestore } from "../../../../src/config/firebase";
import { FieldValue } from "firebase-admin/firestore";
// Copies episode N (draft fields, transcript, interaction id) from one arm into another so both continue from the same episode.
async function main() {
  const [fromId, toId, nArg] = process.argv.slice(2);
  const n = Number(nArg);
  const from = (await inSeriesOrder(fromId!))[n - 1]!;
  const to = (await inSeriesOrder(toId!))[n - 1]!;
  await writeEpisode(toId!, to.id, {
    title: from.title,
    topics: from.topics,
    transcript: from.transcript,
    ttsChunks: from.ttsChunks,
    interactionId: from.interactionId ?? null,
    guests: from.guests,
    status: "ready",
    progress: from.progress,
    error: null,
  });
  await firestore.collection("podcasts").doc(toId!).collection("episodes").doc(to.id).update({
    productionNotes: from.productionNotes ?? FieldValue.delete(),
    continuityNotes: from.continuityNotes ?? FieldValue.delete(),
  });
  log("share", `episode ${n}: ${from.title.slice(0, 60)} (${from.transcript?.split(/\s+/).length} words) copied ${fromId!.slice(0, 8)} -> ${toId!.slice(0, 8)}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
