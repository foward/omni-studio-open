# Trend Watch Service

Standalone scheduled agent for OmniStudio. Every N hours it checks live trends
(Google Trends, YouTube most-popular, Reddit), asks Gemini for viral video ideas
for each of your channels (with ROI estimates), emails you a digest, and holds the
ideas as **pending** until your local OmniStudio app syncs them into its planner.

The heavy video work stays on your Mac; this service is pure API calls, so it runs
happily on Cloud Run's free tier and scales to zero between runs.

## How it connects to the local app

```
┌─────────────────────┐         ┌──────────────────────────┐
│  OmniStudio (Mac)   │ ──PUT /channels──▶ │  Trend Watch (Cloud Run) │
│  local, on demand   │ ◀─GET /state────── │  runs every 5h via       │
│                     │ ──POST /ack──────▶ │  Cloud Scheduler          │
└─────────────────────┘         └───────────┬──────────────┘
        ▲                                   │ state in GCS bucket
        └── digest email ◀──────────────────┘
```

- Opening the local **Planner** pushes your channel list up and pulls new ideas down
  (tagged "Trend Watch", with Why/ROI details).
- The **email digest** arrives even when your Mac is off.

## Deploy to Google Cloud (Cloud Run + Cloud Scheduler)

Prereqs: `gcloud` CLI authenticated, a project selected (`gcloud config set project YOUR_PROJECT`).

```bash
cd trend-watch-service

# 0) One-time: enable services
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com

# 1) Bucket for state
gsutil mb -l us-central1 gs://YOUR_PROJECT-trend-watch

# 2) Deploy (builds the container from source)
gcloud run deploy trend-watch \
  --source . \
  --region us-central1 \
  --no-allow-unauthenticated=false --allow-unauthenticated \
  --memory 256Mi --max-instances 1 \
  --set-env-vars "GEMINI_API_KEY=...,AGENT_SECRET=<long-random-string>,YOUTUBE_API_KEY=...,GCS_BUCKET=YOUR_PROJECT-trend-watch,SMTP_HOST=smtp.gmail.com,SMTP_PORT=587,SMTP_USER=you@gmail.com,SMTP_PASS=<gmail-app-password>,DIGEST_EMAIL_TO=you@gmail.com"

# Grant the Cloud Run service account access to the bucket
gsutil iam ch serviceAccount:$(gcloud run services describe trend-watch --region us-central1 --format 'value(spec.template.spec.serviceAccountName)'):roles/storage.objectAdmin gs://YOUR_PROJECT-trend-watch

# 3) Schedule a run every 5 hours
gcloud scheduler jobs create http trend-watch-5h \
  --location us-central1 \
  --schedule "0 */5 * * *" \
  --uri "$(gcloud run services describe trend-watch --region us-central1 --format 'value(status.url)')/run" \
  --http-method POST \
  --headers "x-agent-secret=<same-long-random-string>"
```

Endpoints stay reachable with the `x-agent-secret` header; `/health` is public.
(The service is exposed publicly but every data endpoint requires the secret.
For belt-and-braces, deploy with `--no-allow-unauthenticated` and give the
Scheduler job an OIDC identity instead — then the local app needs an ID token too.)

## Point the local app at it

Add to the **root** project `.env` and restart the studio:

```
TREND_WATCH_REMOTE_URL=https://trend-watch-xxxxx-uc.a.run.app
TREND_WATCH_REMOTE_SECRET=<same-long-random-string>
```

The planner's Trend Watch panel switches to Cloud mode: it pushes channels and
syncs pending ideas whenever you open it; "Run Now" triggers the cloud agent.

## Run locally / on a VM instead

```bash
cp .env.example .env   # fill in keys
npm install
npm start              # state in ./state.json
# optional: RUN_INTERVAL_HOURS=5 for self-scheduling without Cloud Scheduler
```

## API

All endpoints (except `GET /health`) require header `x-agent-secret: $AGENT_SECRET`.

| Method | Path        | Purpose                                                |
|--------|-------------|--------------------------------------------------------|
| GET    | /health     | Liveness + storage mode                                 |
| PUT    | /channels   | Local app pushes channels (+ known titles for dedupe)   |
| GET    | /state      | Pending ideas, last run, recent digests                 |
| POST   | /ack        | Local app confirms imported idea ids                    |
| POST   | /run        | Trigger a run (Cloud Scheduler hits this)               |
