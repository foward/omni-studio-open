// Direct YouTube upload for OmniStudio (OAuth 2.0 + resumable upload).
//
// Optional & opt-in: needs a YouTube OAuth client. With no config the routes
// return a clear "not configured" status and the app is otherwise unaffected.
//
// Setup (once, in your Google Cloud project):
//   1. Enable "YouTube Data API v3".
//   2. Create an OAuth 2.0 Client ID (type: Web application).
//   3. Add authorized redirect URIs:
//        http://localhost:3000/api/youtube/callback         (local Mac)
//        https://YOUR-CLOUD-RUN-URL/api/youtube/callback     (deployed)
//   4. Put the client id/secret in .env:
//        YT_CLIENT_ID=...  YT_CLIENT_SECRET=...
//
// Uploads default to PRIVATE — nothing goes public until you choose to.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { cloud, saveDoc, loadDoc } from './cloud.js';

const CLIENT_ID = process.env.YT_CLIENT_ID || '';
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET || '';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

let googleMod = null;
async function google() {
  if (!googleMod) googleMod = (await import('googleapis')).google;
  return googleMod;
}

export const youtubeConfigured = () => !!(CLIENT_ID && CLIENT_SECRET);

// Refresh tokens persist independently per Planner channel. This lets Autopilot
// publish to several YouTube channels without replacing the previous login.
const TOKEN_FILE = path.join(process.cwd(), '.youtube-token.json');
function channelKey(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}
function tokenDocId(key) {
  return key ? `tokens_${key}` : 'tokens';
}
function tokenFile(key) {
  return key ? path.join(process.cwd(), `.youtube-token-${key}.json`) : TOKEN_FILE;
}
async function saveCredential(key, credential) {
  if (cloud.firestoreEnabled) return saveDoc('youtube', tokenDocId(key), credential);
  await fs.promises.writeFile(tokenFile(key), JSON.stringify(credential), { mode: 0o600 });
  return true;
}
async function loadCredential(key) {
  let value = null;
  if (cloud.firestoreEnabled) value = await loadDoc('youtube', tokenDocId(key));
  else try { value = JSON.parse(await fs.promises.readFile(tokenFile(key), 'utf8')); } catch { return null; }
  if (!value) return null;
  return value.tokens ? value : { tokens: value, youtubeChannelId: null, youtubeChannelTitle: null };
}
async function clearCredential(key) {
  if (cloud.firestoreEnabled) return saveDoc('youtube', tokenDocId(key), null);
  try { await fs.promises.unlink(tokenFile(key)); } catch { /* ignore */ }
}

function redirectUri(req) {
  if (process.env.YT_REDIRECT_URI) return process.env.YT_REDIRECT_URI;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}/api/youtube/callback`;
}

async function oauthClient(req) {
  const g = await google();
  return new g.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri(req));
}

// An authorized client with the stored refresh token, or null if not connected
async function authorizedClient(req, key) {
  const credential = await loadCredential(key);
  if (!credential?.tokens?.refresh_token) return null;
  const client = await oauthClient(req);
  client.setCredentials(credential.tokens);
  // Persist rotated tokens automatically
  client.on('tokens', (tokens) => {
    saveCredential(key, { ...credential, tokens: { ...credential.tokens, ...tokens } }).catch(() => {});
  });
  return { client, credential };
}

async function oauthUrl(req, key) {
  const client = await oauthClient(req);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: Buffer.from(JSON.stringify({ channelId: key })).toString('base64url')
  });
}

function callbackChannelKey(state) {
  try {
    return channelKey(JSON.parse(Buffer.from(String(state || ''), 'base64url').toString()).channelId);
  } catch {
    return '';
  }
}

export function registerYouTubeRoutes(app, { outputsDir, sanitizeFilename }) {
  // Connection status (+ channel name if connected)
  app.get('/api/youtube/status', async (req, res) => {
    if (!youtubeConfigured()) {
      return res.json({ configured: false, connected: false, message: 'Set YT_CLIENT_ID / YT_CLIENT_SECRET in .env and enable the YouTube Data API.' });
    }
    try {
      const key = channelKey(req.query.channelId);
      const authorized = await authorizedClient(req, key);
      if (!authorized) return res.json({ configured: true, connected: false, channelId: key || null });
      const g = await google();
      const yt = g.youtube({ version: 'v3', auth: authorized.client });
      const me = await yt.channels.list({ part: ['snippet'], mine: true });
      const ch = me.data.items && me.data.items[0];
      res.json({
        configured: true,
        connected: true,
        channelId: key || null,
        channel: ch ? ch.snippet.title : authorized.credential.youtubeChannelTitle || 'your channel',
        youtubeChannelId: ch?.id || authorized.credential.youtubeChannelId || null
      });
    } catch (err) {
      res.json({ configured: true, connected: false, error: err.message });
    }
  });

  // Start OAuth consent
  app.get('/api/youtube/auth', async (req, res) => {
    if (!youtubeConfigured()) return res.status(400).send('YouTube OAuth not configured');
    const key = channelKey(req.query.channelId);
    if (!key) return res.status(400).send('A Planner channelId is required');
    res.redirect(await oauthUrl(req, key));
  });

  app.post('/api/youtube/auth/system', async (req, res) => {
    if (!youtubeConfigured()) return res.status(400).json({ error: 'YouTube OAuth not configured' });
    const key = channelKey(req.body.channelId);
    if (!key) return res.status(400).json({ error: 'A Planner channelId is required' });
    const url = await oauthUrl(req, key);
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ success: true });
  });

  // OAuth callback → store refresh token, bounce back to the app
  app.get('/api/youtube/callback', async (req, res) => {
    try {
      const client = await oauthClient(req);
      const { tokens } = await client.getToken(req.query.code);
      const key = callbackChannelKey(req.query.state);
      if (!key) throw new Error('Missing or invalid Planner channel state');
      const existing = await loadCredential(key);
      // Keep the refresh_token if Google omits it on re-consent
      const mergedTokens = {
        ...(existing?.tokens || {}),
        ...tokens,
        refresh_token: tokens.refresh_token || existing?.tokens?.refresh_token
      };
      client.setCredentials(mergedTokens);
      const g = await google();
      const yt = g.youtube({ version: 'v3', auth: client });
      const me = await yt.channels.list({ part: ['snippet'], mine: true });
      const channel = me.data.items?.[0];
      await saveCredential(key, {
        tokens: mergedTokens,
        youtubeChannelId: channel?.id || null,
        youtubeChannelTitle: channel?.snippet?.title || null
      });
      res.redirect(`/?youtube=connected&channelId=${encodeURIComponent(key)}`);
    } catch (err) {
      console.error('YouTube OAuth callback failed:', err.message);
      res.redirect('/?youtube=error');
    }
  });

  app.post('/api/youtube/disconnect', async (req, res) => {
    const key = channelKey(req.body.channelId);
    if (!key) return res.status(400).json({ error: 'A Planner channelId is required' });
    await clearCredential(key);
    res.json({ success: true });
  });

  // One-time migration helper: copy the legacy global credential into a named
  // Planner channel before authorizing additional channels.
  app.post('/api/youtube/bind-legacy', async (req, res) => {
    const key = channelKey(req.body.channelId);
    if (!key) return res.status(400).json({ error: 'A Planner channelId is required' });
    const legacy = await loadCredential('');
    if (!legacy?.tokens?.refresh_token) return res.status(404).json({ error: 'No legacy YouTube credential found' });
    await saveCredential(key, legacy);
    res.json({ success: true, channelId: key });
  });

  // Upload a rendered video (+ optional thumbnail & captions)
  app.post('/api/youtube/upload', async (req, res) => {
    try {
      const { videoFilename, title, description = '', tags = [], privacyStatus = 'private',
              thumbnailFilename, captionSrt, captionLanguage = 'en', categoryId = '27',
              publishAt = null, channelId } = req.body;
            const key = channelKey(channelId);
            if (!key) return res.status(400).json({ error: 'A Planner channelId is required for YouTube uploads' });
            const authorized = await authorizedClient(req, key);
            if (!authorized) return res.status(401).json({ error: 'This channel is not connected to YouTube.' });

      const safeVideo = sanitizeFilename(videoFilename);
      if (!safeVideo) return res.status(400).json({ error: 'Missing/invalid video filename' });
      const videoPath = path.join(outputsDir, safeVideo);
      if (!fs.existsSync(videoPath)) return res.status(400).json({ error: 'Rendered video not found — render it first' });
      if (!title || !title.trim()) return res.status(400).json({ error: 'A title is required' });

      let privacy = ['private', 'unlisted', 'public'].includes(privacyStatus) ? privacyStatus : 'private';

      // Scheduled publishing: YouTube requires the video to sit private with a
      // future publishAt — it flips to public automatically at that moment.
      let scheduleAt = null;
      if (publishAt) {
        const when = new Date(publishAt);
        if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid publishAt date' });
        if (when.getTime() < Date.now() + 60000) return res.status(400).json({ error: 'publishAt must be in the future' });
        privacy = 'private';
        scheduleAt = when.toISOString();
      }

      const g = await google();
      const yt = g.youtube({ version: 'v3', auth: authorized.client });

      console.log(`Uploading ${safeVideo} to YouTube (${privacy}${scheduleAt ? `, goes public ${scheduleAt}` : ''})...`);
      const insert = await yt.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: { title: title.slice(0, 100), description: description.slice(0, 5000), tags: (tags || []).slice(0, 30), categoryId },
          status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, ...(scheduleAt ? { publishAt: scheduleAt } : {}) }
        },
        media: { body: fs.createReadStream(videoPath) }
      });
      const videoId = insert.data.id;
      console.log(`Uploaded: https://youtu.be/${videoId}`);

      // Optional thumbnail
      if (thumbnailFilename) {
        const safeThumb = sanitizeFilename(thumbnailFilename);
        const thumbPath = safeThumb && path.join(outputsDir, safeThumb);
        if (thumbPath && fs.existsSync(thumbPath)) {
          try {
            await yt.thumbnails.set({ videoId, media: { body: fs.createReadStream(thumbPath) } });
          } catch (e) { console.warn('Thumbnail set failed (needs a verified channel):', e.message); }
        }
      }

      // Optional caption track from SRT text
      let captionUploaded = false;
      if (captionSrt && captionSrt.trim()) {
        try {
          const srtPath = path.join(outputsDir, `yt_caption_${Date.now()}.srt`);
          await fs.promises.writeFile(srtPath, captionSrt);
          await yt.captions.insert({
            part: ['snippet'],
            requestBody: { snippet: { videoId, language: captionLanguage, name: captionLanguage.toUpperCase(), isDraft: false } },
            media: { body: fs.createReadStream(srtPath) }
          });
          fs.unlink(srtPath, () => {});
          captionUploaded = true;
        } catch (e) { console.warn('Caption upload failed:', e.message); }
      }

      res.json({ success: true, videoId, url: `https://youtu.be/${videoId}`, privacy, captionUploaded, publishAt: scheduleAt });
    } catch (error) {
      console.error('YouTube upload error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });
}
