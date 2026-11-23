/**
 * Reproduces the episode wizard's draft path (the controller's wizardOptions) for a real podcast WITHOUT saving
 * anything (the rebuilt chain id is not remembered), and logs what the draft call is given: whether it is chained,
 * how many transcripts are in its system instruction, whether it is asked for notes, and whether the response carries
 * any. It does make the real calls (the catch-up call, when the latest episode has no stored interaction id, and the
 * draft), so it costs a little.
 *
 *   npx tsx .claude/skills/prompt-ab-test/scripts/wizard-path.ts <podcastId>
 */
import { firestore } from "../../../../src/config/firebase";
import { getPriorEpisodes } from "../../../../src/data/episode.repository";
import { getSource } from "../../../../src/data/source.repository";
import { MAX_HISTORY_EPISODES } from "../../../../src/constants/episodeHistory";
import { withContinuity, defaultContinuityDeps, usesInteractionContext } from "../../../../src/services/episodeGeneration/continuity";
import { generateSuggestions } from "../../../../src/services/episodeWizard.service";
import { episodeWizardSystemInstruction } from "../../../../src/llm/prompts/episodeWizard.prompts";
import { inSeriesOrder } from "./lib";
import type { Podcast } from "../../../../src/schemas/podcast.schema";

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: wizard-path.ts <podcastId>");
  const podcast = (await firestore.collection("podcasts").doc(id).get()).data() as Podcast;
  const last = (await inSeriesOrder(id)).at(-1)!;
  const sources = (await Promise.all(last.sourceIds.map((s) => getSource(id, s)))).filter((s) => s !== null);
  const prior = await getPriorEpisodes(id, undefined, MAX_HISTORY_EPISODES);
  console.log(`podcast "${podcast.title}" | useInteractionContext=${podcast.useInteractionContext} -> chain mode: ${usesInteractionContext(podcast)} | prior transcripts: ${prior.length} | latest episode has interaction id: ${!!prior.at(-1)?.episode.interactionId}`);
  const deps = {
    ...defaultContinuityDeps,
    async catchUp(p: Podcast, pr: typeof prior) {
      console.log(`  -> catch-up call: sends ${pr.length} full transcripts to rebuild the chain`);
      return defaultContinuityDeps.catchUp(p, pr);
    },
    async remember() {
      console.log("  -> (not saving the rebuilt chain id: dry run)");
    },
  };
  const result = await withContinuity(
    podcast,
    prior,
    async (c) => {
      const sys = episodeWizardSystemInstruction(podcast, "medium", c.previousEpisodes, c.previousInteractionId !== undefined);
      console.log(`  draft call: chained=${c.previousInteractionId !== undefined} | transcripts in its system instruction: ${c.previousEpisodes.length} (${/with their full transcripts/.test(sys) ? "full transcript block present" : "no transcript block"}) | asks for notes: ${/"continuityNotes"/.test(sys)}`);
      return generateSuggestions(podcast, sources, "medium", c.previousEpisodes, undefined, c.previousInteractionId);
    },
    deps,
  );
  for (const [i, s] of result.suggestions.entries())
    for (const [j, e] of s.episodes.entries())
      console.log(`  suggestion ${i}.${j}: continuityNotes in the response: ${e.continuityNotes ? e.continuityNotes.length + " chars" : "none"}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
