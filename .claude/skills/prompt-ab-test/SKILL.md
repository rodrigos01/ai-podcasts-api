---
name: prompt-ab-test
description: Run a controlled A/B test of a prompting or model change on this app's episode script generation (history method, system instruction, prompt wording, model, thinking level…) against real shows, and decide whether to ship it. Use when asked to compare ways of generating transcripts, try a new prompt/model, "run an A/B", or evaluate a generation change before shipping.
---

# A/B testing script-generation changes

Script generation is one non-deterministic LLM call per episode, and every episode depends on the ones before it (history). So a fair comparison needs **arms that share a baseline and differ in exactly one thing**, generated against real source material, and judged on several measures at once. The history-method test of 2026-10-14/15 (conclusions in AGENTS.md → "Continuity") is the worked example this skill is built from.

Real, billed API usage: an episode is ~1.5-2.5 min and one Gemini call (more if validation fails and it retries, up to 3×). Be deliberate about arm count and episode count; 4-5 episodes per arm is enough to see a pattern.

## Setup

- Needs deps (`npm ci`) and these env vars for anything that touches Firestore (cloud sessions have no `.env`; `config/env.ts` exits without them, and so do two of the vitest suites):
  `FIREBASE_PROJECT_ID=ai-audio-book FIREBASE_SERVICE_ACCOUNT_PATH=/root/credentials/service-account.json FIREBASE_STORAGE_BUCKET=ai-audio-book-podcast-audio AUDIO_URL_SECRET=<any 32+ chars>`
- Scripts live in `.claude/skills/prompt-ab-test/scripts/` and run in place: `npx tsx .claude/skills/prompt-ab-test/scripts/<name>.ts`. Put scratch output (transcripts, logs) in the session scratchpad, not the repo.
- Find the show to test on by listing `podcasts` (a quick `firestore.collection("podcasts").get()` script). Test podcasts from earlier runs may still exist (as of 2026-10-22 only "Armchair Travel Diaries (Test New)" is left, under one test user; the others were deleted). Reuse one as the **template** (owner, hosts, sources) or the original show as the episode **source**, but don't delete or reuse them as arms without asking. Deleting a test podcast: use `deletePodcast` from `data/podcast.repository.ts` (Firestore + audio), not the app's delete endpoint, which also deletes the hosts' designed voices that sibling arms share.

## Method

1. **One variable per arm.** Add the experiment as code paths selected by an optional field on the podcast (`podcast.schema.ts` create/update schemas, one spread in `podcast.repository.ts`'s `createPodcast`, and a small helper that reads it). Default (field absent) must render **byte-identically** to the current behavior: check it by dumping the old prompt module with `git show <ref>:path > src/.../_old.ts`, rendering old vs new for each real episode, and comparing strings (delete the temp file after). Arms then need nothing but a different field value, and every arm runs the same code. For a model test, make the model a field the same way and thread it into `generatePlainText` (`TEXT_MODEL` is a constant in `geminiClient.ts`). Put variant logic in one function both `orchestrator.ts` and the harness call (`lib.ts`'s `buildContext` mirrors the orchestrator; keep them in step).
2. **Identical baseline.** Episode 1 is generated once and copied into every arm, so the arms diverge only from episode 2 (episode 1 has no history, so it's the same under any history variant; if the change affects episode 1 itself, generate it per arm instead and say so). Arms are copies of one podcast so they use the same hosts, premise and sources.
3. **Same episodes, same order, same sources.** `setup-arm.ts` copies a source podcast's episodes with ids translated and the original order kept.
4. **Inspect before spending.** Render the prompt for a real episode in each arm and read it (system instruction and prompt). Then run **one** episode in the riskiest arm and read the raw output before launching everything. See the placeholder trap below.
5. **Run arms in lockstep, episodes in order.** `generate-arms.ts` generates episode N in all arms in parallel, then moves to N+1.
6. **Judge on more than length** (below), with the same metrics for every arm.
7. **Say what the sample is.** One run per arm is one sample of a non-deterministic process. Report differences as observations, flag anything that could flip on a rerun, and rerun the interesting case before shipping a claim. Episode 1 alone ranged from 121 to 182 turns across prompt versions that differed very little, so a single-episode difference of that size means nothing; take about three samples before attributing an effect to a wording.
8. **One change at a time when you want to know why.** A round that bundles several prompt edits can only say "the round changed X". The 2026-10-21 revision bundled a tone rule, a recap rule, a tag rule and a backchannel line; turns got longer, the backchannel line was blamed and reverted, and the turns stayed long. If an effect needs explaining, ablate: one edit reverted per arm.
9. **Start from the real show.** Test podcasts are copies, and copies drift: the template here had "in short, episodic beats" where the real show says "line by line", which by itself made the host read 3-5 diary beats per turn. Diff the arm podcast's `description`, `structure` and host personas against the original before generating anything.

## Steps

```bash
K=.claude/skills/prompt-ab-test/scripts
# 1. create each arm (a copy of the template + all of the source podcast's episodes, ungenerated)
npx tsx $K/setup-arm.ts <sourcePodcastId> <templatePodcastId> "Show Name (Test A)" '{"yourFlag":"a"}'
npx tsx $K/setup-arm.ts <sourcePodcastId> <templatePodcastId> "Show Name (Test B)" '{"yourFlag":"b"}'
# 2+3. generate: episode 1 once (copied to every arm; if the seed podcast has no episode 1 transcript yet it is generated
#    in the first arm), then episodes 2..N in lockstep across arms. Background it and log to the scratchpad.
nohup npx tsx $K/generate-arms.ts <seedPodcastId, or armAId> 5 <armAId> <armBId> > $SCRATCH/gen.log 2>&1 &
#    Variations (flags go first):
#      --only 3   copy episodes 1-2 from the seed into every arm and generate just episode 3 (a costly model, one representative episode)
#      --from 6 <seed> 7 <arms...>   copy 1-5 from the seed (e.g. an existing arm that is the control) and generate 6-7
#      --redraft <originalPodcastId>  draft each episode from episode 2 on through the episode wizard (the real
#                 pipeline: title, topics, guest and production notes come from the draft call, given the sources, the
#                 length, this arm's transcripts so far, and the original episode's production notes as the user prompt).
#                 Use it when the stored outlines could be leaking structure. Arms with identical history share one draft.
#                 Episode 1 keeps its stored draft. setup-arm.ts --episodes 5 copies only the first 5 episodes.
# 4. export and analyze
npx tsx $K/export.ts <armAId> A $SCRATCH/transcripts 5
python3 $K/analyze.py stats $SCRATCH/transcripts/A*.md
python3 $K/analyze.py overlap $SCRATCH/transcripts/A5.md $SCRATCH/transcripts/A[1-4].md
# after fixing a bug in the code under test: reset an arm's episodes and rerun step 2
npx tsx $K/reset-arm.ts <armPodcastId> 2
```

Watch progress with the Monitor tool on the log (grep `done|rror`), not sleep loops. Monitors expire after 30 min; the background processes don't, and survive an interrupted turn. As each episode finishes, export it and send the transcripts to the user (as files: they are 40-70k characters each).

## Things that went wrong (and how to spot them)

- **A placeholder in the prompt gets copied literally.** A format line `[first label]: line` made the model write `[Penny]: ...`, which `scriptText.ts` doesn't parse → `"Gemini returned a script with no recognizable turns"` after 3 retries. Never show a stand-in where the model must write real text; describe it in words. The symptom is an arm that is much slower than its siblings (retries) and then fails. When one arm lags, check the log and reproduce that single call, saving the raw output.
- **Arm differences you didn't intend.** Anything else you changed to make the variant work is a confound (the history test also moved the speaker labels into the prompt and reworded the format section). List every such difference in the report.
- **`runEpisodeGeneration` is the wrong thing to call from a harness**: it designs voices (billed) and leaves guest voices behind. The harness mirrors it without voice resolution; it does hold the generation lease so a deployed server doesn't start the same episode when its status poll finds a `generating` episode with no lease. Episodes the harness hasn't reached are in exactly that state, so a client opening the app can start them — worth telling the user.
- **Firestore rejects `undefined`.** Omit optional fields instead of setting them (this bit `progress.targetWordRange`).
- **`pkill -f <script name>` kills your own shell** when the name is in the command line (exit 144), and `pgrep -af` matches itself. Kill by PID or use a pattern the command itself doesn't contain.
- **The arm's title reaches the prompt.** The system instruction names the show, so arms titled "(Test A)" / "(Test B)" would see different system instructions. `lib.ts` generates under the title minus the `(Test X)` suffix (`baseTitle`). When you render prompts to compare arms (step 4), strip the suffix the same way and check the strings are equal. (The 2026-10 history test did not strip it, so each arm's system instruction named it "(Test X)": equal across episodes within an arm, different between arms, and unlikely to matter, but unintended.)
- **A rule that is both a preference and a condition gets obeyed through its condition.** "Use backchanneling regularly, whenever a turn runs past a couple of sentences" was suspected of making the model stretch turns to have somewhere to put one; with the condition removed it used none at all. Models take a concrete cue over a stated preference. When you want more of a behavior, give it a cue that doesn't change something else you care about, and measure both.
- **The GitHub Actions run listing lags.** After pushing to `staging` the new deploy run did not appear in `list_workflow_runs` for several minutes, though it had started within seconds of the push; I wrongly told the user it hadn't. Don't report "no deploy" from one listing; say you couldn't confirm yet.
- **Slow episodes** (10+ minutes against ~2) happen. Retries after a failed validation are silent, so a slow run could be one; throttling is the other candidate. If it matters, log each failed attempt in `generateEpisodeScript`.
- **Log labels** come from the podcast title's `(Test X)` suffix; keep that pattern or logs say `ab1234`.
- **Arm podcasts share the template's host voice ids**, so deleting one deletes a voice its siblings use. Don't delete arms without asking, and say what you left behind when you finish.

## What to look at

- **Format validity first** (`analyze.py stats`, `analyze.py checks`): `unparsed_paragraphs` is 0, `labels` has exactly the two expected names and is balanced, no bracketed labels, `backchannel_at_turn_edge` 0, `turns_with_digits` ~0 (numbers should be words; identifiers like "H1-B" are fine), `tags_not_1_2_words` 0, and `Label: Style:` paragraphs absent. A new prompt can open new failure modes, so scan for them even when the change looks unrelated: the 2026-10-21 revision produced spoken lines fused into one angle-bracket tag and `Penny: Style: warm` paragraphs that the TTS would have read aloud. Fix those in code (parser, validation + retry), not only in the prompt.
- **Source readings** (`analyze.py quotes`): for shows that read a source out, how long each quoted passage is (median/90th percentile/longest). It caught the "short, episodic beats" structure wording making the host read 3-5 beats at a time.
- **Conversational shape** (the density lesson in AGENTS.md): `words_per_turn` (~22-28 on the reference show), `question_ending_%` (~9-16%), `same_speaker_back_to_back` ~0.
- **Length vs target** (`lengthRanges.ts`). It varies a lot by arm *and* by episode; an episode short in every arm (the history test's episode 5, a second part with little source left) is the source's scope, not the variant. Compare each arm to the others on the same episode.
- **Reuse of earlier episodes**: `analyze.py overlap` (verbatim 8-grams; ~0.5-1% on the reference show), plus whether structure, beats and jokes are being rebuilt from earlier episodes (read two or three stretches of a transcript against an earlier one).
- **Continuity actually used**: callbacks that are accurate, recurring segments and catchphrases kept, nothing contradicting an earlier episode.
- **Style lines**: the current prompt yields very few (~2/episode, in every arm tried); don't read a drop in them as a regression of the variant without checking the control arm.
- **Read the prose.** Metrics catch format problems and gross shifts, not whether it's good. Read an opening, a middle stretch and the ending of at least one episode per arm, and for any arm that passes intermediate text to the writer (notes, summaries) read that text against its source for misattributions.

## Closing out

Decide with the user which arm ships. Pushing a branch to `staging` (documented in AGENTS.md) triggers its deploy automatically; use it to get the change in front of the user. Then make the shipped behavior the **only** behavior: delete the other variants, the per-podcast fields and the flag plumbing (restore touched files with `git checkout origin/main -- <paths>` and re-apply only what ships — the diff against main should be just the winner), keep the unit tests for the shipped behavior (prompt rendering is pure and testable; the live calls are verified by running episodes, per the repo's testing philosophy), add a short "what was tested and why this shape" note to AGENTS.md without the transcripts, and run two or three more real episodes with the **final** code (not an arm's) to confirm nothing regressed when the flags came out. Open the PR with the numbers, the confounds and the follow-ups you noticed but left alone. Leftover test podcasts: list them in the PR and let the user decide.
