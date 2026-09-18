# OmniStudio

**OmniStudio is a local, AI-native video production suite.** From a single idea or a trending topic, it writes the script, generates every scene, narrates or sings it, masters the audio, designs the thumbnail, writes the SEO/monetization kit, renders the master with FFmpeg, and — in **Autopilot mode** — schedules and publishes finished videos to YouTube with no human in the loop.

It runs entirely on your own machine with your own Google Gemini API key. Optional Google Cloud sync, a standalone Trend Watch agent, and per-channel YouTube publishing let it scale from "make me one video" to "run several channels on their own."

> Built with Google Gemini (text, image, Omni video, TTS, Lyria music) + FFmpeg + Node.js.

---

## 🎬 Built with OmniStudio

I built OmniStudio and used it to launch and run **three real YouTube channels in fully automated Autopilot mode** — each one picks trending ideas, produces the video end to end, and publishes on a schedule:

- 🌿 **Wild Child Explorers** — https://www.youtube.com/@WildChildExplorers
- 🧠 **Translating Tech** — https://www.youtube.com/@Translatingtech
- 🎨 **Clay Tunes Kids** — https://www.youtube.com/@ClayTunesKids

Everything from trend discovery → script → scenes → narration/song → thumbnail → SEO → upload runs hands-free once a channel's Autopilot switch is on.

— *[Francisco Riveros](https://www.linkedin.com/in/panchoriveros/)*

---

## ✨ Features

**Creation**
- **AI scene video generation** — Gemini Omni model turns each scene prompt into a video clip, with character consistency (reference images) and shot-to-shot background continuity.
- **Two production modes** — *Explainer* (topic → timed script → narrated video) and *Music* (lyrics/song → Lyria track → karaoke-timed storyboard).
- **Narration & voices** — multi-line timed TTS with an automatic engine fallback chain (Gemini Flash Audio → Gemini 2.5 TTS → local `say`).
- **Original music** — instrumental beds and full sung songs via Google Lyria, with automatic lyric transcription for subtitles.
- **Localization** — translate and re-voice narration into other markets.

**Packaging & polish**
- **Intelligent mastering** — loudness-normalized, broadcast-ready audio.
- **AI thumbnails, title/intro/outro cards, channel logos & brand kits.**
- **SEO & monetization kit** — titles, description, tags, hooks, pinned comment, chapter markers.
- **Auto-Shorts** — cut vertical highlights from the master automatically.
- **Coherence & realism review** — Gemini scores scene continuity and realism and can auto-regenerate weak scenes.

**Planning & automation**
- **Content Planner** with live **Trends Radar** (Google Trends, YouTube most-popular, Reddit, Hacker News, Wikipedia, Google News).
- **Autopilot Production Queue** — hands-free idea → produced → scheduled → published, ranked by ROI.
- **Trend Watch** — an optional standalone cloud agent that watches trends 24/7 and feeds fresh, ROI-ranked ideas into your planner.

**Publishing & sync**
- **Per-channel YouTube publishing** (OAuth) — multiple channels coexist; uploads default to private and auto-publish at a scheduled time.
- **Optional Google Cloud sync** — mirror media to Cloud Storage and metadata to Firestore so two machines share one workspace.

---

## 🚀 Quick start

**Requirements**
- Node.js 20+
- [FFmpeg](https://ffmpeg.org/) on your `PATH`
- A [Google Gemini API key](https://aistudio.google.com/apikey)

```bash
npm install
cp .env.example .env      # then paste your GEMINI_API_KEY
npm start
```

Open **http://localhost:3000** and follow the 4-step wizard:

1. **Setup** — pick a character and describe your video (or configure a song).
2. **Storyboard** — review and generate scenes.
3. **Studio & Render** — preview, master the audio, and render the final video.
4. **Publish & SEO** — generate the SEO kit + thumbnail, cut Shorts, and publish to YouTube.

Everything past a Gemini key is optional — add credentials only for the features you want.

---

## ⚙️ Configuration

All configuration is via environment variables in `.env` (see [`.env.example`](.env.example) for the full annotated list). Highlights:

| Variable | Purpose | Default |
|---|---|---|
| `GEMINI_API_KEY` | **Required.** Google Gemini API key. | — |
| `GEMINI_TEXT_MODEL` | Text model for scripts/SEO/planning. | `gemini-3.6-flash` |
| `GEMINI_IMAGE_MODELS` | Image models, tried in order. | `gemini-3.1-flash-image-preview,gemini-3-pro-image-preview` |
| `GEMINI_OMNI_MODEL` | Scene video generation model. | `gemini-omni-1.1-flash-preview` |
| `LYRIA_MODEL` | Music generation model. | `lyria-3-pro-preview` |
| `PORT` | Server port (Cloud Run injects 8080). | `3000` |
| `YT_CLIENT_ID` / `YT_CLIENT_SECRET` | YouTube OAuth (publishing). | — |
| `YOUTUBE_API_KEY` | YouTube trends + stats. | — |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | Reddit trend signals. | — |
| `PEXELS_API_KEY` / `PIXABAY_API_KEY` | Free stock b-roll. | — |
| `SMTP_HOST/PORT/USER/PASS`, `DIGEST_EMAIL_TO` | Email digests for Trend Watch. | — |
| `GCP_PROJECT_ID`, `GCS_BUCKET` | Optional Cloud Storage + Firestore sync. | — |
| `TREND_WATCH_REMOTE_URL` / `TREND_WATCH_REMOTE_SECRET` | Point at a deployed Trend Watch agent. | — |
| `AUTOPILOT_PAUSED` | Set to disable all Autopilot workers. | — |

---

## 🤖 Autopilot mode

Turn on `channel.autopilot.enabled` for a channel in the Planner and OmniStudio runs your channel for you:

1. **Trend Watch** (local scheduler or the deployed cloud agent) surfaces fresh, ROI-ranked video ideas.
2. **Full Autopilot** keeps exactly one job per channel queued, picking the best unproduced idea by ROI.
3. The job **calls OmniStudio's own pipeline** — the same endpoints the UI uses — to produce script, scenes, narration/song, realism pass, master render, SEO, and thumbnail.
4. The finished video is archived to your cloud library and **uploaded to YouTube as private with a future `publishAt`**, so it goes public on schedule.

The three channels above run exactly this loop. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full pipeline.

---

## ☁️ Optional cloud sync

Set `GCP_PROJECT_ID` and `GCS_BUCKET` in `.env` to mirror generated media to Cloud Storage and projects/planner/tokens to Firestore. Two machines pointed at the same project share one workspace. Requires Application Default Credentials (`gcloud auth application-default login`) or a service account. The `@google-cloud/*` SDKs are optional dependencies and load only when configured.

## 📡 Trend Watch service

`trend-watch-service/` is a separate, deployable agent (Cloud Run + Cloud Scheduler) that watches trends on a schedule and emails you ROI-ranked ideas even when your machine is off. See [`trend-watch-service/README.md`](trend-watch-service/README.md).

## 🐳 Docker

```bash
docker build -t omni-studio .
docker run -p 8080:8080 --env-file .env omni-studio
```

The image bundles FFmpeg, fonts, and zip, and is ready for Cloud Run / GCE / GKE.

---

## 🔒 Security

- **Never commit** real API keys, OAuth credentials, service-account files, tokens, logs, generated media, or user data. The included [`.gitignore`](.gitignore) already excludes `.env`, `*.key`/`*.pem`, `.youtube-token*.json`, `public/outputs/`, `planner.json`, and the autopilot queue.
- All secrets are read from environment variables — there are no hardcoded keys in the source.
- Run a secret scanner such as [Gitleaks](https://github.com/gitleaks/gitleaks) before publishing changes.
- Security-relevant fixes are logged in [`.jules/sentinel.md`](.jules/sentinel.md).

## 📚 Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, data flow, API surface, and the Autopilot pipeline.
- [`trend-watch-service/README.md`](trend-watch-service/README.md) — deploying the cloud trend agent.
- [`creative_videos.md`](creative_videos.md) — the viral-video content playbook the AI prompts draw on.

## 🤝 Contributing

Issues and pull requests are welcome. Please don't include real credentials or generated media in PRs, and run a secret scan first.

## Author

**Francisco Riveros** — [linkedin.com/in/panchoriveros](https://www.linkedin.com/in/panchoriveros/)

## License

[Apache 2.0](LICENSE)
