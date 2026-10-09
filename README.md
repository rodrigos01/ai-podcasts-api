# AI Podcast API

A REST API that generates realistic, fully-produced podcast episodes: a single LLM call writes a full back-and-forth conversation between fictional hosts and guests (2 voices per episode — never more, never fewer), and the resulting transcript is synthesized to streamable audio — all from a short prompt and whatever source material you give it.

Product behavior is fully described in [specs.md](specs.md); this document covers how to run the service and how to call it.

## How it works, in short

1. **Create a podcast** via a 3-option wizard: describe what you want, pick (and iteratively revise) one of three generated concepts — title, description, structure, and fictional hosts with voices and personas.
2. **Upload source material** (text or PDF) for a podcast — background reading the hosts and guests will actually reference.
3. **Create an episode** via a wizard: pick a target length up front, point it at some sources, get back one or two suggestions — each either a single episode draft or a natural 2-episode split, whichever fits it best (a lone suggestion can itself be a split, e.g. if your prompt asked for one; a second suggestion only appears when there's a genuine alternative worth offering). Revise and confirm a suggestion (both its drafts, for a split) as a whole.
4. Confirming a suggestion kicks off **generation in the background** for every episode in it at once: a single LLM call writes each episode's full transcript (both speakers), a "producer" LLM turns episode metadata into a TTS direction sheet, and the transcript is chunked for synthesis. Poll each episode's own status endpoint until it's `ready`. For a confirmed 2-part split, the server generates the parts sequentially behind the scenes — part 2 only starts once part 1 is `ready`, so it inherits part 1's continuity notes — transparently to the caller.
5. **Stream the audio** from a single endpoint that behaves like a normal seekable audio file once fully generated, and like a live/growing stream (playable, but not seekable ahead of what exists yet) while still being synthesized.

## Tech stack

- Node 20+, TypeScript, Express
- Firebase Firestore (a **named database**, not the default one — see Setup) + Firebase Storage, via `firebase-admin`
- Google Gemini `gemini-3.8-flash` for text and `gemini-3.8-flash-tts` for speech, both via `@google/genai` on the **Gemini Enterprise Agent Platform** (formerly Vertex AI) — no API key. Speech uses `generateContentStream` plus the Voices API (Voice Design), one streaming call per chunk of turns
- zod for request validation and for validating every piece of LLM-generated JSON before it's trusted
- vitest for unit tests

## Setup

### 1. Firebase project

You need a Firebase/GCP project with:
- A **Firestore database** — this project uses a *named* database (default `podcasts`, not `(default)`). Create it if it doesn't exist:
  ```bash
  firebase firestore:databases:create podcasts --location=<your-region>
  ```
- A **Storage bucket**, registered with Firebase (a plain GCS bucket won't show up in the Firebase console's Storage tab or be usable here until it's linked):
  ```bash
  gcloud services enable firebasestorage.googleapis.com --project <your-project>
  gcloud storage buckets create gs://<your-bucket> --project <your-project> --location=<region> --uniform-bucket-level-access
  # then link it to Firebase:
  curl -X POST -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
    "https://firebasestorage.googleapis.com/v1beta/projects/<your-project>/buckets/<your-bucket>:addFirebase"
  ```
- A **service account key** (JSON), for local dev only — see Environment below. In any deployed environment (Cloud Run, etc.) this is omitted entirely and the app uses Application Default Credentials via the runtime's own attached service account instead.
- The **Vertex AI / Gemini Enterprise Agent Platform API enabled**, and the service account (local key or the deployed runtime's own attached one) granted the `roles/aiplatform.user` role — needed for text generation and speech (TTS + Voice Design), which run through that API rather than an API key:
  ```bash
  gcloud services enable aiplatform.googleapis.com --project <your-project>
  ```

### 2. Environment

Create a `.env` file (never commit it):

```bash
FIREBASE_PROJECT_ID=...
FIREBASE_SERVICE_ACCOUNT_PATH=./path-to-service-account.json
FIREBASE_STORAGE_BUCKET=your-bucket-name
FIRESTORE_DATABASE_ID=podcasts
PORT=3000
```

`FIREBASE_SERVICE_ACCOUNT_PATH` is optional — set it for local dev (pointing at a downloaded service-account JSON key); leave it unset in any deployed environment. `FIREBASE_PROJECT_ID` doubles as the Gemini Enterprise project — Firebase projects are GCP projects, and text generation and speech run against this same project.

### 3. Install & run

```bash
npm install
npm run dev      # tsx watch, restarts on file changes
```

```bash
npm run build && npm start   # compiled/production
npm test                     # unit tests — fast, no network calls
npm run smoke                 # scripts/smoke-test.ts — drives the full real HTTP flow end to end
```

`npm test` is safe to run anytime. `npm run smoke` and any real usage of the wizard/generation/audio endpoints make real, billed calls to Gemini — be deliberate with how often you run a full episode through generation.

### 4. Deploy to Cloud Run

```bash
npm run deploy   # scripts/deploy.sh — gcloud run deploy --source, from .env
```

Reads `.env` and forwards it as Cloud Run env vars, deliberately excluding `PORT` (Cloud Run injects its own), `FIREBASE_SERVICE_ACCOUNT_PATH` (deployed environments use Application Default Credentials instead — see Setup), and anything not actually read by `src/config/env.ts`. Override the target service/region with `SERVICE_NAME=`/`REGION=`.

## Authentication

Every `/podcasts` route (including everything nested under it — sources, episodes, audio) requires a **Firebase Auth ID token**. This backend never handles credentials itself: your client signs in with the Firebase Auth SDK directly (email/password, anonymous, or any provider you enable on the project), then sends the resulting ID token on every request:

```
Authorization: Bearer <firebase-id-token>
```

For the one endpoint meant to be handed straight to a media player (`.../audio/stream`), a plain `<audio src="...">` can't attach custom headers — pass the token as a query param instead: `.../audio/stream?token=<firebase-id-token>`. The header is checked first if both are present.

Podcasts (and everything under them) are private to the user who created them — a podcast that exists but belongs to someone else looks identical to a `404`.

`/health`, `GET /voices` and `GET /voices/:voiceId/preview` don't require auth. `POST /voices/design` does (it makes billed calls) — send the same `Authorization` header.

## API reference

All request/response bodies are JSON unless noted.

### Health & reference data

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/voices` | A legacy reference list of 30 voice IDs with gender/trait — informational only; `voice` on a host/guest is now a free-text description, not a pick from this list (see below) |
| POST | `/voices/design` | Design 3 candidate voices from a prompt (auth required) — see [Voice design](#voice-design) |
| GET | `/voices/:voiceId/preview` | Sample audio (WAV) of a designed voice — public, usable as an `<audio src>` |

### Podcasts

| Method | Path | Description |
|---|---|---|
| POST | `/podcasts/wizard/options` | Generate 3 podcast concept options from a prompt |
| POST | `/podcasts/wizard/revise` | Revise one option or all three, from a free-text instruction |
| POST | `/podcasts` | Confirm a (possibly user-edited) option — creates the podcast |
| GET | `/podcasts` | List all podcasts |
| GET | `/podcasts/:podcastId` | Get one podcast |
| PATCH | `/podcasts/:podcastId` | Edit title/description/structure/hosts (affects future episodes only) |
| DELETE | `/podcasts/:podcastId` | Delete a podcast and everything under it (episodes, sources, cached audio) |

**`POST /podcasts/wizard/options`**
```json
// request
{ "prompt": "A podcast where two friends review obscure kitchen gadgets.", "sourceMaterial": "optional inspiration text" }

// response
{
  "sessionId": "…",   // the voice-design session for this wizard run — see Voice design
  "options": [
    {
      "title": "...", "description": "...", "structure": "... (markdown)",
      "languageCode": "pt-BR",   // the language the show is spoken in (BCP-47) — voices are designed for it
      "hosts": [{
        "name": "...", "voice": "warm, gravelly older British male", "persona": "...",
        "voicePrompt": "Name: ...\n\n<persona>\n\nAccent: ..."   // optional — the prompt a voice would be designed from
      }],
      "predictedChanges": ["...", "...", "..."]
    }
    // x3
  ]
}
```

**`POST /podcasts/wizard/revise`**
```json
// request — omit targetIndex to revise all 3 at once
{ "options": [ /* the 3 options as returned above */ ], "sessionId": "…", "targetIndex": 0, "instruction": "Make this option more comedic" }
// response: same shape as /wizard/options (sessionId is echoed back; omit it in the request and you get a new one)
```

**`POST /podcasts`** — body is `{ title, description, structure, languageCode?, hosts: [{name, voice, persona, ...}], sessionId? }` (drop `predictedChanges` from a chosen option; keep its `languageCode`). `voice` is a free-text description (e.g. "warm, gravelly older British male"), not a pick from `GET /voices`'s legacy catalog. The real synthesizable voice is a designed one: either the one the user picked via [Voice design](#voice-design) (send it as the host's `resolvedVoiceId`, along with the wizard's `sessionId`), or, if none is picked, one the server designs itself the first time the podcast's audio is generated, from the host's `voicePrompt` (see below). Returns `201` with the created podcast, including a generated `id` and per-host `id`s.

`voicePrompt` on a host is the exact text a voice is designed from. The wizards return it; send it back as-is, or edit it. If a host is saved without one, the server builds it from the name, the persona and the accent as written (in the show's own language — nothing is translated; the podcast's `languageCode` is sent alongside it when a voice is designed) and stores it. Editing a host's name, persona or accent rebuilds its stored prompt, unless you send a prompt of your own.

**`PATCH /podcasts/:podcastId`** — any subset of `{title, description, structure, languageCode, hosts}`. When editing `hosts`, include each existing host's `id` to keep it stable (episodes reference hosts by id); omit `id` on a new host. Voice rules when `hosts` is sent:
- `resolvedVoiceId` set to a candidate picked in this podcast's design session (the session id is the **podcast id**) → that voice is stored (and `voicePrompt` becomes the prompt it was designed from).
- Otherwise, if the host's `voicePrompt` changed (or the persona/accent/name it's built from did) → the stored voice is dropped and a new one is designed in the background from the new prompt, so it's usually ready by the next generation.
- Otherwise the host keeps its voice. Sending back the `resolvedVoiceId` you got from a GET is a no-op.

### Voice design

Hosts and guests are voiced by designed voices. Clients can let the user try out candidates for a person while the wizards propose them, and when editing them afterwards:

1. The wizard responses (`.../wizard/options` and `.../wizard/revise`, podcast and episode) carry a **`sessionId`** and, on every host/guest, a **`voicePrompt`**. (When editing an existing podcast or episode there's no wizard: the session id is the **podcast id** or **episode id**, and the prompt is on the person.)
2. `POST /voices/design` with that session and a prompt — the person's `voicePrompt`, optionally edited — designs **3 candidate voices** and returns them with preview URLs. Call it again (same `sessionId`) for 3 more. It takes a while: expect ~20 seconds.
3. Play a candidate with its `previewUrl` — an `<audio src>` or a native player works directly.
4. When saving (`POST /podcasts`, `POST .../episodes`, `PATCH` of a podcast's hosts or an episode's guests), send the chosen voice as the person's **`resolvedVoiceId`**. For the two `POST`s also send the wizard's `sessionId` in the body.
5. On save the server keeps the chosen voice, deletes all the session's other unused candidates (including ones for people you didn't pick a voice for), and stores the prompt the chosen voice was designed from on the person. So a wizard's session is for one save; for an edit the session is the podcast/episode id, which can be reused for as many edits as you like. Cleanup happens when hosts/guests are included in the `PATCH` body, not on a title-only edit.

**`POST /voices/design`** (auth required)
```json
// request
{
  "sessionId": "…",
  "prompt": "Name: Maya Cruz\n\nA warm, curious former radio producer…\n\nAccent: light Irish",
  "languageCode": "pt-BR"   // optional — the podcast's language: the wizard's languageCode, or the podcast's own when editing
}

// response
{
  "sessionId": "…",
  "voices": [
    { "voiceId": "voice_…", "previewUrl": "https://<api-host>/voices/voice_…/preview" }
    // up to 3 — fewer if some failed; 502 only when all of them did
  ]
}
```
`sessionId` is any string up to 128 characters: use the one a wizard returned, or the podcast/episode id when editing. Candidates are private to the user who designed them, so another user's session ids never overlap with yours. `previewUrl` is absolute.

**Language.** Voices are designed for the podcast's language. The podcast wizard returns a `languageCode` on every option (a BCP-47 tag such as `en-US` or `pt-BR`; `en_US` is accepted and normalised to the hyphenated form), the episode wizard returns the podcast's `languageCode` at the top level of its responses, and an existing podcast carries its own — pass whichever applies as `languageCode` on `POST /voices/design`. Send it back as `languageCode` on `POST /podcasts` so voices the server designs itself (at generation, or in the background after a host edit) use it too. It's optional everywhere: a podcast without one is designed without a language, as before, and an unrecognisable value is ignored rather than rejected.

**`GET /voices/:voiceId/preview`** — no auth. Returns the candidate's sample as `audio/wav` (24 kHz, mono, 16-bit) with a `Content-Length`, so it plays in an `<audio>` tag or ExoPlayer. The sample can run to 30 seconds or more. `400` if the id isn't a designed voice id, `404` if it doesn't exist (e.g. it was already cleaned up).

**Things to know**
- Unknown or stale ids are ignored, not rejected: a `resolvedVoiceId` that isn't one of your unused candidates in that session (including one left over from an earlier save, or from a session that was already saved) is handled as if you hadn't sent it — the server designs a voice from the stored prompt, as it always did.
- A picked voice is kept as the person's voice until you pick another one or its prompt changes. A guest's picked voice also survives `/regenerate`, unlike an unpicked guest's, which is designed per generation. Deleting an episode or podcast deletes its voices.
- Changing a person's voice doesn't touch audio that's already been generated for an episode: an episode that was partly streamed keeps the old voice for that part, and `/regenerate` is how to get a consistent episode.
- **Previewing a person's current voice:** hosts and guests in responses carry a computed, absolute **`voicePreviewUrl`** (ready for an `<audio>` tag or ExoPlayer) when they have a voice that can be played. It's present for a host with a usable voice, and for a guest whose voice was picked via design; it's absent otherwise. A guest the server designed a voice for by itself has a temporary voice that's deleted once the episode's audio has been generated, so it has no preview URL. The field is response-only: you don't need to (and can't) send it back.
- Every field here is optional for existing clients: ignore `sessionId`, `voicePrompt` and `resolvedVoiceId` and everything works as before, with the server designing voices itself.

### Sources

| Method | Path | Description |
|---|---|---|
| POST | `/podcasts/:podcastId/sources` | Add a source — JSON `{title, contents}`, multipart file upload, or a Google Drive file |
| GET | `/podcasts/:podcastId/sources` | List sources for a podcast |
| GET | `/podcasts/:podcastId/sources/:sourceId` | Get one source |
| DELETE | `/podcasts/:podcastId/sources/:sourceId` | Delete a source |

Three ways to add a source, on the same endpoint:
- **File upload**: `POST` multipart form-data with a `file` field (PDF only — text is extracted server-side); an optional `title` field overrides the default (the filename).
- **Plain text**: JSON `{"title": "...", "contents": "..."}`.
- **Google Drive**: JSON `{"fileId": "<drive-file-id>", "accessToken": "<oauth-access-token>", "title": "optional override"}`. `accessToken` is *your client's own* Google OAuth access token (obtained via Google Sign-In with Drive read scope, e.g. `drive.readonly`) — this backend has no Drive credentials of its own and forwards the token to Google only for this one request, never storing it. Supports Google Docs (exported as plain text) and PDF files stored in Drive (extracted the same way as an uploaded PDF); any other file type is rejected with `400`. An expired/invalid token comes back as `401`; a file the token can't access as `403`.

### Episodes

| Method | Path | Description |
|---|---|---|
| POST | `/podcasts/:podcastId/episodes/wizard/options` | Generate 1-2 episode suggestions from a target length + sources (+ optional prompt) |
| POST | `/podcasts/:podcastId/episodes/wizard/revise` | Revise one draft within the suggestions from a free-text instruction |
| POST | `/podcasts/:podcastId/episodes` | Confirm a whole suggestion (1 or 2 episodes) — creates all of them and starts generation (`202`) |
| GET | `/podcasts/:podcastId/episodes` | List episodes |
| GET | `/podcasts/:podcastId/episodes/:episodeId` | Get one episode (includes transcript once ready) |
| GET | `/podcasts/:podcastId/episodes/:episodeId/status` | Lightweight status poll (no transcript payload) |
| PATCH | `/podcasts/:podcastId/episodes/:episodeId` | Edit title/topics/productionNotes, and the guest (including picking a designed voice) |
| DELETE | `/podcasts/:podcastId/episodes/:episodeId` | Delete an episode and its cached audio |
| POST | `/podcasts/:podcastId/episodes/:episodeId/regenerate` | Restart generation for a stuck/failed episode (from scratch) |

**`POST /podcasts/:podcastId/episodes/wizard/options`** — `length` is chosen up front here, before drafting, so the drafter can shape the episode for it from the start (and detect when it's the wrong fit for the material).
```json
// request
{ "sourceIds": ["<source-id>"], "prompt": "optional steering prompt", "length": "short" }

// response — always an array. Usually just one suggestion:
{
  "suggestions": [
    {
      "episodes": [
        {
          "title": "...", "topics": "...", "productionNotes": "...",
          "guests": [{ "name": "...", "voice": "bright, upbeat young woman", "persona": "...", "voicePrompt": "…" }],
          "predictedChanges": ["...", "...", "..."]
        }
      ]
    }
  ],
  "sessionId": "…",          // the voice-design session for this wizard run — see Voice design
  "languageCode": "pt-BR"    // the podcast's language, for voice design (omitted if the podcast has none)
}

// ...but when a split is the right call, a suggestion's own "episodes" array has 2 entries
// instead of 1 — either as the only suggestion (e.g. the prompt explicitly asked for a
// split), or alongside a single-episode alternative worth offering side by side:
{
  "suggestions": [
    { "episodes": [ /* "Part 1" draft */, /* "Part 2" draft */ ] }
  ]
}
// or, when there's a genuine choice worth presenting:
{
  "suggestions": [
    { "episodes": [ /* single-episode best-effort fit */ ] },
    { "episodes": [ /* "Part 1" draft */, /* "Part 2" draft */ ] }
  ]
}
```

There's no positional convention here — a suggestion's shape is entirely described by its own `episodes.length` (1 = single episode, 2 = split); don't assume `suggestions[0]` is always the single-episode option or that `suggestions[1]`, if present, is always the split. It's equally valid for the lone suggestion to be a split, or for two suggestions to both have the same episode count. There is no more `suggestedLength` output hint — length is an input now, not something suggested after the fact. To confirm any one suggestion, pass its whole `episodes` array to the confirm endpoint below in one call — the server sequences the actual generation itself (see below), so this is exactly the same call regardless of how many episodes that suggestion contains.

**`POST /podcasts/:podcastId/episodes/wizard/revise`**
```json
// request
{
  "suggestions": [ /* the suggestions array as returned above */ ],
  "length": "short",
  "targetSuggestionIndex": 0,
  "sessionId": "…",          // optional — echo the one you got, to stay in the same voice-design session
  "targetEpisodeIndex": 1,   // optional — omit to revise every draft within that suggestion; set to revise just one (e.g. only "Part 2")
  "instruction": "Make this part more comedic"
}
// response: same shape as /wizard/options
```

**`POST /podcasts/:podcastId/episodes`** (confirm — takes a whole suggestion's `episodes` array, 1 or 2 entries)
```json
// request — same shape for a single-episode suggestion (1 entry) or a confirmed split (2 entries)
{
  "episodes": [
    {
      "title": "...",
      "topics": "...",
      "length": "short",            // "short" | "medium" | "long"
      "sourceIds": ["<source-id>"],
      "participantHostIds": ["<host-id>"],
      "guests": [{ "name": "...", "voice": "bright, upbeat young woman", "persona": "...", "voicePrompt": "…", "resolvedVoiceId": "voice_…" }],
      "productionNotes": "..."
    }
    // a second entry here, for a confirmed split
  ],
  "sessionId": "…"   // optional — the wizard's voice-design session; needed for resolvedVoiceId to be applied
}

// response (202) — every episode is created immediately
{ "episodes": [ /* created Episode objects, in the same order */ ] }
```

For a split, both episodes are created right away, but generation runs sequentially behind the scenes: the second one's script generation doesn't actually start until the first reaches `ready`, so it can see the first's transcript — the same continuity any other follow-up episode gets (the transcripts of up to the 15 episodes before it, by `createdAt`). This is entirely transparent to the caller: poll each episode's own `/status` as usual, and the second one just shows no progress yet until its turn comes.

**`PATCH /podcasts/:podcastId/episodes/:episodeId`** — any subset of `{title, topics, productionNotes, guests}`. `guests` must have as many entries as the episode already has (the 2-voice rule below still holds); include a guest's `id` to keep it, omit it for a new person. The voice rules are the same as for a podcast's hosts (see [Voice design](#voice-design)), with the **episode id** as the session. Guests' voices are designed when the episode is generated, not at save time.

**Important constraint**: `participantHostIds.length + guests.length` must equal exactly **2** — every episode is voiced by either 2 hosts or 1 host + 1 guest, never more or fewer. A single-host podcast therefore requires a guest on every episode.

Episode length word/time targets:

| Length | Words | Approx. time |
|---|---|---|
| `short` | 3500-5000 | 20-35 min |
| `medium` | 6500-8000 | 40-50 min |
| `long` | 8000-9000 | ~50-65 min |

**Episode status lifecycle**: `generating` → `streamable` → `ready` (or `failed`, with `error` set). The transcript is written by a single LLM call, streamed so turns are persisted and TTS chunks sealed progressively as they're confirmed — once both cast members have spoken at least once, the episode flips to `streamable` and `/stream` will already serve audio for whatever's been sealed so far, well before the whole script is done. Treat `streamable` the same as `ready` for "go ahead and call `/stream`"; `ready` specifically means the whole script finished and the final chunk boundaries are set (e.g. for full-seek support). If a generation issue can't be recovered after a chunk has already been exposed to a listener, the episode still reaches `ready` with a shorter-than-targeted transcript rather than failing outright — `error` carries an explanatory message in that case, but doesn't block playback. Poll `/status` (returns `{status, progress, error, generatedAudioSeconds}`, where `progress` includes the current stage and word count, and `generatedAudioSeconds` is the total audio duration generated/cached so far) rather than the full episode while waiting.

### Audio

| Method | Path | Description |
|---|---|---|
| GET | `/podcasts/:podcastId/episodes/:episodeId/audio/stream` | Stream the episode's audio |
| DELETE | `/podcasts/:podcastId/episodes/:episodeId/audio` | Clear the episode's cached audio so the next stream synthesizes it again (the script is kept) |

This is a single audio resource for the whole episode (not per-chunk), designed to be pointed at directly by a standard `<audio>` element or a native mobile player:

- **Once fully generated**: behaves like a normal static audio file — proper `Content-Length`, `Accept-Ranges: bytes`, full seek support via `Range` requests.
- **While still generating**: served as `audio/ogg` (Ogg Opus) over `Transfer-Encoding: chunked` (no `Content-Length`, since the final size isn't known yet). Playback can start immediately and can be paused/resumed, but cannot be scrubbed ahead of what's actually been generated. A `Range: bytes=N-` request resumes precisely from `N` if that's already been generated; if not, it triggers generation of whatever's needed to reach it. `Episode.generatedAudioSeconds` (see `/status` above) tells a client how much audio currently exists, for building a "scrub within what's generated so far" UI — it's updated in Firestore as each chunk finishes, not computed on request.
- Audio generation is genuinely on-demand — the first request for a given episode's stream is what triggers TTS synthesis (in chunks, cached from then on), not episode confirmation. Expect real latency the first time any given episode is streamed.

**Clearing the audio** — `DELETE .../audio` (`204`) throws away the episode's cached audio without touching its script, so the next `/stream` synthesizes it again from scratch — e.g. after changing a host's or guest's voice, which doesn't affect audio that already exists. It also resets the audio settings that belong to it: `generatedAudioSeconds` goes back to `0`, `audioComplete` to `false` and `audioDurationSeconds` to `null`, the stored chunking is dropped (it is recomputed from the transcript), leftover chunk locks are removed, and a guest whose voice the server designed (not one the user picked) loses it, to be designed again with the new audio. A picked voice is kept. Audio that is being synthesized at that moment is cancelled first (on any instance), and the listener it was streaming to is disconnected — a player that retries then gets the freshly generated audio. `409` while the script is still being generated (there is no audio yet), or if a running generation can't be stopped within about 15 seconds; otherwise it works for any status, and clearing an episode with no cached audio is a no-op. Unlike `/regenerate` it never rewrites the script, so it is cheap until someone plays the episode again.

**Resuming from a saved position**: pass `?t=<seconds>` to start the stream from a playback position your app already has (e.g. the user exited the player and came back) — `GET .../audio/stream?t=754.2`. The server resumes at the nearest generated-audio-chunk boundary at or before that time (not an exact byte offset — audio chunks are compressed, so a chunk's duration isn't known until it's been generated) — if a `Range` header is present on the same request, it takes precedence over `t`.

## Data model

- **Podcast**: `title`, `description`, `structure` (markdown), `languageCode?`, `hosts[]` (each a *person*: `id`, `name`, `voice`, `persona`, `accent?`, `voicePrompt?`, `resolvedVoiceId`, plus server-managed voice fields; responses also add the computed `voicePreviewUrl?`).
- **Source**: `title`, `contents` (extracted plain text), `sourceType`.
- **Episode**: `title`, `topics`, `length`, `sourceIds[]`, `participantHostIds[]`, `guests[]` (people, same shape as hosts), `productionNotes`, `status`, `progress`, `transcript`, `generatedAudioSeconds` (total audio duration generated so far), `error`.

## Known limitations

- No automatic resume if the process restarts mid-episode-generation. The transcript is persisted progressively as turns are confirmed (not just once the whole script finishes), so a crash mid-call loses only the still-unvalidated tail, not the whole episode — but there's still no resume: `/regenerate` restarts the episode from scratch rather than picking back up from whatever was already persisted.
- No hard word-count guarantee. The single LLM call that writes the transcript has no mid-generation checkpoint, so it can overshoot the target `length`'s word range — especially when the source material is genuinely denser than the target, since the model tends to track the material's real scope over the literal target. Splitting into multiple episodes (see the episode wizard above) is the main mitigation today.
- No structural guarantee that each speaker only knows their own material. One LLM call writes both speakers' lines, so "each speaker only knows what's in their own persona/material/what's been said aloud" is prompted for, not enforced the way giving each speaker an independent, separately-scoped LLM call would.
- A multi-part episode (from a 2-episode split suggestion) has no persisted link between its parts — each is an ordinary, independent `Episode` document. Grouping is conveyed only through their drafted `title`/`topics`/`productionNotes` text, not a schema-level relationship.
- `GET /podcasts` (list) scans every podcast in the database and filters by owner in memory, rather than a Firestore-indexed query — fine at today's scale, but worth revisiting if the number of users/podcasts grows significantly.
- Every call to the wizard, episode generation, and audio endpoints makes real, billed calls to the Gemini API.
