/**
 * Runs the episode wizard's draft call N times in parallel for episode E of an arm (history = its earlier
 * transcripts, drafted the way the arm does) and counts how many come back usable, with an optional thinking
 * level, to compare the draft call's failure rate. Nothing is written.
 *
 *   npx tsx .../draft-reliability.ts <armPodcastId> <notesPodcastId> <episodeNumber> <samples> <thinking|none>
 */
import { firestore } from "../../../../src/config/firebase";
import { getSource } from "../../../../src/data/source.repository";
import { generateSuggestions } from "../../../../src/services/episodeWizard.service";
import { withContinuity } from "../../../../src/services/episodeGeneration/continuity";
import type { Podcast } from "../../../../src/schemas/podcast.schema";
import type { PriorEpisode } from "../../../../src/utils/episodeHistory";
import { baseTitle, inSeriesOrder, isDegenerateDraft } from "./lib";

async function main() {
  const [armId, notesId, nArg, samplesArg, thinkingArg] = process.argv.slice(2);
  if (!armId || !notesId || !nArg || !samplesArg || !thinkingArg) throw new Error("usage: draft-reliability.ts <arm> <notesPodcast> <episodeNumber> <samples> <thinking|none>");
  const n = Number(nArg);
  const thinking = thinkingArg === "none" ? undefined : (thinkingArg as "minimal" | "low" | "medium" | "high");
  const stored = (await firestore.collection("podcasts").doc(armId).get()).data() as Podcast;
  const podcast = { ...stored, title: baseTitle(stored.title) };
  const episodes = await inSeriesOrder(armId);
  const target = episodes[n - 1]!;
  const prior: PriorEpisode[] = episodes.slice(0, n - 1).map((episode, i) => ({ number: i + 1, episode })).filter((p) => p.episode.transcript);
  const sources = (await Promise.all(target.sourceIds.map((id) => getSource(armId, id)))).filter((s) => s !== null);
  const prompt = (await inSeriesOrder(notesId))[n - 1]?.productionNotes;
  const needsNotes = !podcast.useInteractionContext && prior.length > 0;
  const outcomes = await Promise.all(
    Array.from({ length: Number(samplesArg) }, async () => {
      const t0 = Date.now();
      try {
        const result = await Promise.race([
          withContinuity(podcast, prior, (c) => generateSuggestions(podcast, sources, target.length, c.previousEpisodes, prompt, c.previousInteractionId, thinking)),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout 240s")), 240_000)),
        ]);
        const d = result.suggestions[0]!.episodes[0]!;
        return { ok: !isDegenerateDraft(d, needsNotes), why: isDegenerateDraft(d, needsNotes) ? "degenerate" : "", secs: Math.round((Date.now() - t0) / 1000), notes: d.continuityNotes?.length ?? 0 };
      } catch (e) {
        return { ok: false, why: e instanceof Error ? (e.message.includes("timeout") ? "timeout" : e.message.includes("too_small") || e.name === "ZodError" ? "schema" : e.message.slice(0, 40)) : "error", secs: Math.round((Date.now() - t0) / 1000), notes: 0 };
      }
    }),
  );
  const ok = outcomes.filter((o) => o.ok);
  console.log(`thinking=${thinkingArg}: ${ok.length}/${outcomes.length} usable | seconds ${outcomes.map((o) => o.secs).sort((a, b) => a - b).join(",")} | failures: ${outcomes.filter((o) => !o.ok).map((o) => o.why).join(",") || "none"} | notes chars (usable) ${ok.map((o) => o.notes).join(",")}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
