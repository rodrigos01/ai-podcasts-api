# AI Podcast API

A REST API that generates realistic, fully-produced podcast episodes: fictional hosts and guests hold a real back-and-forth conversation (each driven by an independent LLM agent), and the resulting transcript is synthesized to streamable audio — all from a short prompt and whatever source material you give it.

Product behavior is fully described in [specs.md](specs.md); this document covers how to run the service and how to call it.

## How it works, in short

1. **Create a podcast** via a 3-option wizard: describe what you want, pick (and iteratively revise) one of three generated concepts — title, description, structure, and fictional hosts with voices and personas.
2. **Upload source material** (text or PDF) for a podcast — background reading the hosts and guests will actually reference.
3. **Create an episode** via a single-draft wizard: point it at some sources, get a draft (title, topics, production notes, an optional guest), revise it, confirm it.
4. Confirming an episode kicks off **generation in the background**: two independent LLM agents (2 hosts, or 1 host + 1 guest — never more, never fewer) hold a real conversation turn by turn, a "producer" LLM turns the transcript into a TTS direction sheet, and the transcript is chunked for synthesis. Poll a status endpoint until it's `ready`.
5. **Stream the audio** from a single endpoint that behaves like a normal seekable audio file once fully generated, and like a live/growing stream (playable, but not seekable ahead of what exists yet) while still being synthesized.

## Tech stack

- Node 20+, TypeScript, Express
- Firebase Firestore (a **named database**, not the default one — see Setup) + Firebase Storage, via `firebase-admin`
- Google Gemini `gemini-3.8-flash` for text (via `@google/genai`) and `gemini-3.1-flash-tts-preview` for speech (via `@google-cloud/text-to-speech`'s `streamingSynthesize`, for real incremental audio streaming at a much cheaper cost basis than the same model through `@google/genai`'s Interactions API)
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

### 2. Environment

Create a `.env` file (never commit it):

```bash
GEMINI_API_KEY=...
FIREBASE_PROJECT_ID=...
FIREBASE_SERVICE_ACCOUNT_PATH=./path-to-service-account.json
FIREBASE_STORAGE_BUCKET=your-bucket-name
FIRESTORE_DATABASE_ID=podcasts
PORT=3000
```

`FIREBASE_SERVICE_ACCOUNT_PATH` is optional — set it for local dev (pointing at a downloaded service-account JSON key); leave it unset in any deployed environment.

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

`/health` and `/voices` don't require auth.

## API reference

All request/response bodies are JSON unless noted.

### Health & reference data

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/voices` | The 30 available TTS voice IDs, with gender and character trait |

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
  "options": [
    {
      "title": "...", "description": "...", "structure": "... (markdown)",
      "hosts": [{ "name": "...", "voice": "Puck", "persona": "..." }],
      "predictedChanges": ["...", "...", "..."]
    }
    // x3
  ]
}
```

**`POST /podcasts/wizard/revise`**
```json
// request — omit targetIndex to revise all 3 at once
{ "options": [ /* the 3 options as returned above */ ], "targetIndex": 0, "instruction": "Make this option more comedic" }
// response: same shape as /wizard/options
```

**`POST /podcasts`** — body is `{ title, description, structure, hosts: [{name, voice, persona}] }` (drop `predictedChanges` from a chosen option). Returns `201` with the created podcast, including a generated `id` and per-host `id`s.

**`PATCH /podcasts/:podcastId`** — any subset of `{title, description, structure, hosts}`. When editing `hosts`, include each existing host's `id` to keep it stable (episodes reference hosts by id); omit `id` on a new host.

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
| POST | `/podcasts/:podcastId/episodes/wizard/options` | Generate a single episode draft from sources (+ optional prompt) |
| POST | `/podcasts/:podcastId/episodes/wizard/revise` | Revise the draft from a free-text instruction |
| POST | `/podcasts/:podcastId/episodes` | Confirm a draft — creates the episode and starts generation (`202`) |
| GET | `/podcasts/:podcastId/episodes` | List episodes |
| GET | `/podcasts/:podcastId/episodes/:episodeId` | Get one episode (includes transcript/ttsPrompt once ready) |
| GET | `/podcasts/:podcastId/episodes/:episodeId/status` | Lightweight status poll (no transcript payload) |
| PATCH | `/podcasts/:podcastId/episodes/:episodeId` | Edit title/topics/productionNotes |
| DELETE | `/podcasts/:podcastId/episodes/:episodeId` | Delete an episode and its cached audio |
| POST | `/podcasts/:podcastId/episodes/:episodeId/regenerate` | Restart generation for a stuck/failed episode (from scratch) |

**`POST /podcasts/:podcastId/episodes/wizard/options`**
```json
// request
{ "sourceIds": ["<source-id>"], "prompt": "optional steering prompt" }

// response
{
  "draft": {
    "title": "...", "topics": "...", "productionNotes": "...",
    "guests": [{ "name": "...", "voice": "Kore", "persona": "..." }],
    "predictedChanges": ["...", "...", "..."]
  }
}
```

**`POST /podcasts/:podcastId/episodes`** (confirm)
```json
{
  "title": "...",
  "topics": "...",
  "length": "short",            // "short" | "medium" | "long"
  "sourceIds": ["<source-id>"],
  "participantHostIds": ["<host-id>"],
  "guests": [{ "name": "...", "voice": "Kore", "persona": "..." }],
  "productionNotes": "..."
}
```

**Important constraint**: `participantHostIds.length + guests.length` must equal exactly **2** — every episode is voiced by either 2 hosts or 1 host + 1 guest, never more or fewer. A single-host podcast therefore requires a guest on every episode.

Episode length word/time targets:

| Length | Words | Approx. time |
|---|---|---|
| `short` | 3500-5000 | 20-35 min |
| `medium` | 6500-8000 | 40-50 min |
| `long` | 8000-9000 | ~50-65 min |

**Episode status lifecycle**: `generating` → `ready` (or `failed`, with `error` set). Poll `/status` (returns `{status, progress, error}`, where `progress` includes the current stage and running word count) rather than the full episode while waiting.

### Audio

| Method | Path | Description |
|---|---|---|
| GET | `/podcasts/:podcastId/episodes/:episodeId/audio/stream` | Stream the episode's audio |

This is a single audio resource for the whole episode (not per-chunk), designed to be pointed at directly by a standard `<audio>` element or a native mobile player:

- **Once fully generated**: behaves like a normal static audio file — proper `Content-Length`, `Accept-Ranges: bytes`, full seek support via `Range` requests.
- **While still generating**: served as `audio/ogg` (Ogg Opus) over `Transfer-Encoding: chunked` (no `Content-Length`, since the final size isn't known yet). Playback can start immediately and can be paused/resumed, but cannot be scrubbed ahead of what's actually been generated. A `Range: bytes=N-` request resumes precisely from `N` if that's already been generated; if not, it triggers generation of whatever's needed to reach it.
- Audio generation is genuinely on-demand — the first request for a given episode's stream is what triggers TTS synthesis (in chunks, cached from then on), not episode confirmation. Expect real latency the first time any given episode is streamed.

**Resuming from a saved position**: pass `?t=<seconds>` to start the stream from a playback position your app already has (e.g. the user exited the player and came back) — `GET .../audio/stream?t=754.2`. The server resumes at the nearest generated-audio-chunk boundary at or before that time (not an exact byte offset — audio chunks are compressed, so a chunk's duration isn't known until it's been generated) — if a `Range` header is present on the same request, it takes precedence over `t`.

## Data model

- **Podcast**: `title`, `description`, `structure` (markdown), `hosts[]` (each with `id`, `name`, `voice`, `persona`).
- **Source**: `title`, `contents` (extracted plain text), `sourceType`.
- **Episode**: `title`, `topics`, `length`, `sourceIds[]`, `participantHostIds[]`, `guests[]`, `productionNotes`, `status`, `progress`, `transcript`, `ttsPrompt`, `ttsChunks[]` (internal chunk boundaries), `condensedSummaries` (per-host continuity notes carried into future episodes), `error`.

## Known limitations

- No automatic resume if the process restarts mid-episode-generation; the transcript-so-far is preserved, but `/regenerate` restarts the whole conversation from scratch rather than continuing it.
- `GET /podcasts` (list) scans every podcast in the database and filters by owner in memory, rather than a Firestore-indexed query — fine at today's scale, but worth revisiting if the number of users/podcasts grows significantly.
- Every call to the wizard, episode generation, and audio endpoints makes real, billed calls to the Gemini API.
