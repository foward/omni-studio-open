# OmniStudio

OmniStudio is a local AI video production application for generating music videos and explainers, assembling scenes with FFmpeg, planning channel content, and optionally publishing to YouTube.

## Requirements

- Node.js 20 or newer
- FFmpeg
- A Gemini API key
- Optional Google Cloud, YouTube OAuth, Reddit, SMTP, and stock-media credentials

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

Keep `.env`, OAuth tokens, generated media, Planner data, and local launch scripts private. The included `.gitignore` excludes these files.

## Optional cloud sync

Set `GCP_PROJECT_ID` and `GCS_BUCKET` in `.env` to enable Cloud Storage and Firestore integration. Application Default Credentials or a service account are required.

## Security

Do not commit real API keys, OAuth credentials, service-account files, tokens, logs, generated media, or user data. Run a secret scanner such as Gitleaks before publishing changes.

## Author

**Francisco Riveros** — [linkedin.com/in/panchoriveros](https://www.linkedin.com/in/panchoriveros/)

## License

Apache 2.0 — see [LICENSE](LICENSE).
