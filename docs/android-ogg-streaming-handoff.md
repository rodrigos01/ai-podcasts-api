# Handoff: Android audio streaming (`/stream`) still broken

Moving this to a local session for easier on-device debugging. This doc captures where things stand, what's been tried, what's confirmed vs. assumed, and what to check next.

**Branch**: `claude/exciting-hopper-n0xt2g` (rebased onto latest `main` as of this doc)
**PR**: https://github.com/rodrigos01/ai-podcasts-api/pull/1
**Status**: user reports still seeing issues on Android after the latest push (`2d0309d`, "Fix chained-Ogg playback with a single-stream remux instead of WebM"). **The exact current symptom/error hasn't been captured yet** — that's the first thing to nail down locally (see "Next steps").

## The original problem

`/stream` served episode audio with a `Content-Type: audio/ogg` MIME type, and playback had issues on Android during streaming. The original ask was to look into keeping the storage-side compression benefit of Ogg Opus while fixing whatever was breaking Android playback.

## Timeline of what's been tried

### Attempt 1 (reverted): switch delivery container to WebM

**Hypothesis**: Android's media stack broadly dislikes the Ogg container over progressive HTTP; switch the whole delivery format to WebM/Opus (container remux only, same codec, no re-encode).

**What was built** (now reverted): `src/utils/webmRemux.ts`, `complete.webm` artifact, `Content-Type: audio/webm; codecs=opus`.

**Result on a real device**: worse. ExoPlayer failed outright:
```
None of the available extractors (FlvExtractor, FlacExtractor, WavExtractor, FragmentedMp4Extractor,
Mp4Extractor, AmrExtractor, PsExtractor, OggExtractor, TsExtractor, MatroskaExtractor, AdtsExtractor,
Ac3Extractor, Ac4Extractor, Mp3Extractor, AviExtractor, JpegExtractor, PngExtractor, WebpExtractor,
BmpExtractor, HeifExtractor, AvifExtractor) could read the stream.
```
Never root-caused precisely — the leading hypothesis (not confirmed) is that the live/in-progress path's WebM output has an **unknown-size Segment element** (forced by writing to a non-seekable pipe, since ffmpeg can't rewind to patch in a real size once the stream is done), and ExoPlayer's `MatroskaExtractor` may not handle that reliably. This was never actually isolated — it's possible the *fully-cached* path (a real, seekable, properly-finalized `complete.webm` file with real Cues) would have worked fine and only the *live* path was broken, or it could be something else entirely. **Nobody confirmed which of the two serving paths (live vs. fully-cached) was hit when this error was observed.**

### Attempt 2 (current, also reportedly still broken): single-stream Ogg remux

**Correction to the diagnosis**: further discussion with the user clarified the *original* Ogg failure mode more precisely — ExoPlayer's `OggExtractor` decoded the **first** TTS chunk's Opus audio correctly, it just never advanced into the next chunk. That's a much narrower, well-understood gap: this backend caches each TTS chunk as its own independent, self-contained Ogg logical stream (own BOS page, own serial number — see `src/storage/audioCache.repository.ts`), and the original code served episodes by raw-concatenating those chunks. That's spec-legal ("chained" Ogg, RFC 3533) but ExoPlayer's `OggExtractor` doesn't implement chaining — it stops after the first logical stream.

This was verified concretely (not just theorized) in this sandbox:
```bash
# Concatenating two independently-generated Ogg Opus files the way
# audio.service.ts used to:
$ python3 -c '...count BOS pages/serial numbers...'
chained.opus: 2 BOS page(s), serial number(s)={1686592458, 4106643383}
```
Two BOS pages = two logical streams = exactly what `OggExtractor` won't follow past.

**The fix**: keep Ogg Opus end-to-end (same MIME type, same codec) but remux the concatenated chunks into a **single, non-chained** logical Ogg stream before serving (`ffmpeg -c:a copy`, container-level repaging only — no re-encode, no quality/size change). Verified this produces exactly 1 BOS page / 1 serial number covering all the audio, decodes cleanly start to finish via `ffprobe`-equivalent (`ffmpeg -f null -`).

**What's actually implemented** (current `HEAD` of this branch):
- `src/utils/oggRemux.ts` — replaces `webmRemux.ts`. Two entry points:
  - `createChainedOggRemuxer()` — live pipe-based remux (stdin/stdout), used while an episode is still generating.
  - `remuxChainedOggBuffer(buffer)` — one-shot buffer-in/buffer-out remux, used to build the finished per-episode artifact.
- `src/storage/audioCache.repository.ts` — added `getCachedCompleteOgg`/`putCachedCompleteOgg`, storing the finished single-stream artifact at `podcasts/{podcastId}/episodes/{episodeId}/audio/complete.ogg` (`contentType: audio/ogg`). Per-chunk cache (`chunk-{index}.opus`) is unchanged and now purely internal.
- `src/services/audio.service.ts` — `streamEpisodeAudio` now always remuxes before sending:
  - **Fully-cached episode**: `ensureCompleteOgg` builds (once) and persists `complete.ogg`, then serves it as a normal static resource (real `Content-Length`, byte-exact `Range` support via plain buffer slicing).
  - **Still generating**: `relayLiveAudio` spawns one `ffmpeg` process per request, feeds it each chunk's Ogg bytes (cached or freshly generated) in order, and relays its single-stream Ogg stdout to the response as `Transfer-Encoding: chunked`.
  - `?t=<seconds>` resolves to a chunk index (`utils/oggOpus.ts`'s `resolveTimeToChunkIndex`) and always starts a **fresh** single-stream Ogg resource from that chunk onward.
  - A byte-exact `Range: bytes=N-` request is **only honored once the episode is fully cached**; while still generating it's intentionally ignored (serves a full `200` instead) — reproducing an exact prior offset would require re-running the whole remux and discarding leading output, judged not worth the complexity. This is a known, deliberate gap, not an oversight — see the comment above `relayLiveAudio` in `audio.service.ts`.
- `test/audio.service.test.ts` — exercises `streamEpisodeAudio`'s control flow against real `ffmpeg` (via `@ffmpeg-installer/ffmpeg`, a bundled static binary) and asserts the actual invariant that matters: **exactly one logical Ogg stream (one BOS page) in every response**, using synthetic-but-real Ogg Opus fixtures generated on the fly. GCS/Firestore/TTS are mocked (per this repo's testing philosophy — see AGENTS.md).

Full narrative is also recorded in `AGENTS.md`'s "Audio delivery (`/stream`)" section, including the wrong-turn writeup — worth reading before making further changes here.

## What's confirmed vs. NOT confirmed

**Confirmed** (verified in this sandbox, without a real device):
- `ffmpeg` (via `@ffmpeg-installer/ffmpeg`'s bundled static binary) can remux a chained Ogg Opus buffer into a single logical stream, `-c:a copy`, no quality/size loss.
- The live pipe-based remuxer (`createChainedOggRemuxer`) flushes progressively — first output bytes within ms of the first input write, not buffered until the whole input is consumed.
- `tsc --noEmit` is clean and all 49 real unit/integration tests pass (`npm test`) against the current code, including the new Ogg-stream-count assertions.
- The rebase onto latest `main` (`74c7afd`, which added Google Drive source input + switched conversation generation to plain text) was clean — no conflicts, tests still green afterward.

**NOT confirmed — this is the gap that needs closing locally**:
- **Real end-to-end playback on an actual Android device/ExoPlayer has not been verified for the current single-stream Ogg fix.** The user reports "still having issues" after this change landed, but the specific symptom (error message, where in playback it fails, which serving path — live vs. fully-cached — is involved) hasn't been captured in this session.
- Whether the still-generating (live, chunked-transfer) path behaves correctly on-device at all — this is the path most likely to have subtle issues (no `Content-Length`, response built by relaying a live child process's stdout).
- Whether the deployed/tested build actually matches what's on this branch — worth double-checking the Android client is pointed at a server actually running this code before diagnosing further.

## Next steps (suggested)

1. **Get the actual current error/symptom from the device** — logcat around the ExoPlayer failure, and note *which* endpoint/response it was (fully-cached episode vs. one still generating). This is the single most useful piece of information missing right now; everything above was fixed based on inference from a previous, different error message.
2. Once the symptom is known, use `oggRemux.ts`'s two code paths as the split point: confirm independently whether `complete.ogg` (fully-cached, static file case) plays correctly and whether the **live** `Transfer-Encoding: chunked` case is the one still broken — they're different code paths (`ensureCompleteOgg` vs. `relayLiveAudio` in `audio.service.ts`) and could have independent bugs.
3. If it's the live path: consider capturing raw bytes of an actual live response (`curl` the `/stream` endpoint for a still-generating episode, save to a file) and feed that directly to `ffprobe`/`ffmpeg -f null -` to check it's well-formed Ogg, independent of ExoPlayer.
4. If it's the fully-cached path: pull the actual `complete.ogg` object from the bucket for a real episode and inspect it directly (BOS/serial count, `ffprobe`) — the automated test only exercises short synthetic fixtures (~2s sine tones), not a real multi-chunk, multi-minute episode; there could be a scale-dependent issue (e.g. something with the chunk-boundary "Error parsing the packet header" glitch noted in `oggRemux.ts`'s design discussion — a pre-existing, tiny artifact at each chunk's join point that was present before any of this work and hasn't been fully characterized).
5. Keep `AGENTS.md`'s "Audio delivery" section up to date as the real root cause becomes clearer — it already has a "wrong turn" writeup for the WebM detour; extend that pattern rather than replacing it, so the next person (or agent) doesn't re-walk the same paths.
