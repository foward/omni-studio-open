# OmniStudio — Architecture

OmniStudio is a single-user Node.js (ESM, Express) web app that generates complete AI videos with Google Gemini + FFmpeg and can auto-produce and publish them to YouTube. It runs fully local by default, with optional Google Cloud sync and an optional standalone Trend Watch service.

```
                          ┌──────────────────────────────────────────┐
                          │            Browser (public/)             │
                          │  4-step wizard + Planner + Autopilot UI  │
                          └───────────────────┬──────────────────────┘
                                              │  fetch /api/*
                          ┌───────────────────▼──────────────────────┐
                          │              server.js (Express)          │
                          │  scripts · scenes · TTS · music · SEO ·   │
                          │  thumbnails · FFmpeg render · planner     │
                          └───┬───────────┬───────────┬──────────┬────┘
                              │           │           │          │
                  ┌───────────▼──┐  ┌─────▼─────┐ ┌───▼────┐ ┌───▼─────────┐
                  │ autopilot.js │  │ youtube.js│ │cloud.js│ │ Google APIs │
                  │  job queue   │  │  OAuth +  │ │ GCS +  │ │ Gemini/Lyria│
                  │ self-calls   │  │  upload   │ │Firestore│ │ TTS/Omni    │
                  │  /api/*      │  └───────────┘ └────────┘ └─────────────┘
                  └──────────────┘
                              ▲
                   pending ideas (ROI-ranked)
                              │
                  ┌───────────┴──────────────┐
                  │ trend-watch-service/      │  standalone Cloud Run agent
                  │ watches trends, emails    │  (separate deployable)
                  └───────────────────────────┘
```

## Components

### `server.js` — the application server
Express app that serves the SPA from `public/`, exposes `/outputs` for generated media (with lazy Cloud Storage pull-through), and wires in the sub-modules. At startup it detects available FFmpeg filters (`drawtext`, `ass/subtitles`, `gradients`) and initializes optional cloud sync. All generated media lands in `public/outputs`; planner state lives in Firestore or a local JSON file.

Feature areas: scene video generation (Omni + continuity), prompt enhancement, explainer + music/lyric script generation, TTS narration + localization, Lyria music/song + lyric transcription, AI thumbnails/cards/logos/brand kits, SEO & monetization kit, auto-Shorts, coherence & realism review, stock b-roll, FFmpeg master rendering, project import/export, planner + trend radar, YouTube publishing, and cloud archival.

### `autopilot.js` — hands-free production queue
Registered via `registerAutopilot(app, deps)`. Persists a job queue to `.autopilot-queue.json` and runs jobs one at a time. Crucially, the queue **calls the app's own HTTP endpoints on localhost**, so Autopilot reuses the exact pipeline the UI uses.

- **Two pipelines** keyed off channel type: `explainer` (script → music → narration → scenes → realism → render → SEO → thumbnail → upload) and `music` (song → lyrics → storyboard → scenes → realism → render → SEO → thumbnail → upload).
- **Full Autopilot** (`fullAutopilotTick`, ~every 30 min): for each channel with `autopilot.enabled`, keeps exactly one job queued, picks the best unproduced planner idea by ROI, and schedules `publishAt` at the channel's publish hour.
- **Resilience**: survives restarts; a job left `running` at boot is marked interruptible and can be retried (resume from saved artifacts or from scratch). `AUTOPILOT_PAUSED` disables the workers.

### `youtube.js` — OAuth + upload
Opt-in (`YT_CLIENT_ID`/`YT_CLIENT_SECRET`), lazy-imports `googleapis`. **Refresh tokens are stored per Planner channel**, so multiple YouTube channels coexist (Firestore `youtube/tokens_<key>` or `.youtube-token-<key>.json`, mode 0600). Uploads default to **private**; with a future `publishAt` the video auto-publishes on schedule. Optionally sets the thumbnail and inserts an SRT caption track.

### `cloud.js` — optional GCS/Firestore sync
Opt-in, lazy-imports the `@google-cloud/*` SDKs and degrades gracefully (cloud errors are logged and swallowed). Media mirrors to a GCS bucket (`media/`, `library/<channel>/<date>_<title>/`); projects, planner data, and YouTube tokens persist to Firestore. Two machines on the same project share one workspace.

### `trend-watch-service/` — standalone cloud agent
A separate deployable (Cloud Run + Cloud Scheduler). On a schedule it checks live trends (Google Trends, Reddit, YouTube most-popular), asks Gemini for viral, ROI-ranked ideas per channel, stores them as **pending**, and emails a digest. The main app pushes its channel list up (`PUT /channels`), pulls ideas down (`GET /state`), and acknowledges imported ideas (`POST /ack`). All routes except `/health` require a shared `x-agent-secret`.

## Models & external APIs

| Concern | Model / API | Env override |
|---|---|---|
| Text (scripts, SEO, planning) | `gemini-3.6-flash` | `GEMINI_TEXT_MODEL` |
| Images (thumbnails, cards, logos) | `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview` | `GEMINI_IMAGE_MODELS` |
| Scene video | `gemini-omni-1.1-flash-preview` | `GEMINI_OMNI_MODEL` |
| Narration TTS | `gemini-3.1-flash-tts-preview` → `gemini-2.5-flash-preview-tts` → local `say` | — |
| Music / song | `lyria-3-pro-preview` (Interactions API) | `LYRIA_MODEL` |
| Trends / stats | YouTube Data API, Reddit, Google Trends, HN, Wikipedia, Google News | `YOUTUBE_API_KEY`, `REDDIT_*` |
| Stock b-roll | Pexels / Pixabay | `PEXELS_API_KEY`, `PIXABAY_API_KEY` |

Gemini text/image calls hit `.../v1beta/models/<model>:generateContent`; scene video and music use the Interactions API (`.../v1beta/interactions`).

## API surface (selected)

**Creation** — `POST /api/enhance-prompt`, `/api/generate-script`, `/api/generate-explainer-script`, `/api/generate-scene`, `/api/refine-scene`, `/api/generate-turnaround`, `/api/generate-narration`, `/api/generate-music`, `/api/generate-song`, `/api/transcribe-lyrics`, `/api/localize`, `/api/master-track`.

**Packaging** — `POST /api/generate-seo`, `/api/generate-thumbnail`, `/api/generate-title-card`, `/api/generate-logo`, `/api/channel-brand`, `/api/generate-brand-kit`, `/api/review-coherence`, `/api/review-video-realism`.

**Rendering (FFmpeg)** — `POST /api/merge-video`, `/api/merge-video-sync`, `/api/compile-studio-video`, `/api/generate-shorts`, `/api/export-package`.

**Planner & trends** — `GET|PUT /api/planner`; `POST /api/planner/trends-radar`, `/api/planner/trends`, `/api/planner/stats`, `/api/planner/suggest`, `/api/planner/suggest-channel`; `GET|POST /api/trend-watch`, `/api/trend-watch/run-now`, `/api/trend-watch/sync`.

**Autopilot** — `GET /api/autopilot`; `POST /api/autopilot/{drain,enqueue,cancel,retry,auto-run,stop-channel,record-fixed-upload,remove}`.

**YouTube** — `GET /api/youtube/status`, `/api/youtube/auth`, `/api/youtube/callback`; `POST /api/youtube/{auth/system,disconnect,bind-legacy,upload}`.

**Project / cloud** — `POST /api/project/{export,import,organize}`, `/api/archive-render`, `/api/gcs/upload`; `GET /api/cloud/status`, `GET|PUT /api/cloud/projects`, `POST /api/cloud/backfill`; `GET /api/presets`, `POST /api/upload-audio`, `POST /api/notify`.

## Autopilot pipeline (idea → published)

```
Planner idea (Trend Watch or manual)
   └─ Full Autopilot picks best unproduced idea by ROI, sets publishAt
        └─ Job self-calls the pipeline endpoints:
             script/song → music → narration → scenes (continuity)
               → realism pass (regenerate weak scenes)
               → compile-studio-video (master: subs, cards, logo, loudnorm)
               → SEO kit + thumbnail
               → archive-render to GCS library
               → YouTube upload (private + future publishAt)
        └─ Planner row marked scheduled/ready
```

## Runtime state (gitignored)
`.env`, `.autopilot-queue.json`, `.youtube-token*.json`, `planner.json`, `public/outputs/`, `logs/`, `trend-watch-service/state.json`.

## Containerization
- Root `Dockerfile`: `node:22-bookworm-slim` + FFmpeg, DejaVu fonts, zip; `EXPOSE 8080`; targets Cloud Run / GCE / GKE.
- `trend-watch-service/Dockerfile`: `node:22-slim`, no FFmpeg (pure API/scheduler); `EXPOSE 8787`; targets Cloud Run + Cloud Scheduler.
