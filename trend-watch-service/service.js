// Trend Watch Service — standalone scheduled agent for OmniStudio
//
// Checks live trends (Google Trends, YouTube, Reddit), asks Gemini for viral
// video ideas per channel, stores them as "pending ideas", and emails a digest.
// The local OmniStudio app syncs channels up and pulls pending ideas down.
//
// Runs anywhere Node 20+ runs. Designed for Cloud Run (+ Cloud Scheduler) with
// state in a GCS bucket; falls back to a local state.json for dev / VM usage.

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.6-flash';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const GCS_BUCKET = process.env.GCS_BUCKET || '';
const STATE_OBJECT = process.env.GCS_STATE_OBJECT || 'trend-watch-state.json';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const RUN_INTERVAL_HOURS = parseFloat(process.env.RUN_INTERVAL_HOURS || '0'); // 0 = rely on Cloud Scheduler

if (!GEMINI_API_KEY) {
  console.error('Error: GEMINI_API_KEY is not set.');
  process.exit(1);
}
if (!AGENT_SECRET) {
  console.warn('Warning: AGENT_SECRET is not set — endpoints are UNPROTECTED. Set it in production.');
}

const app = express();
app.use(express.json({ limit: '2mb' }));

/* =========================== State store =========================== */
// GCS via REST + the Cloud Run metadata-server token (no SDK needed).
// Outside GCP (no GCS_BUCKET), state lives in a local JSON file.

const EMPTY_STATE = { channels: [], pendingIdeas: [], digests: [], lastRun: null };

async function gcsToken() {
  const resp = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!resp.ok) throw new Error(`metadata token failed: ${resp.status}`);
  return (await resp.json()).access_token;
}

async function loadState() {
  if (GCS_BUCKET) {
    try {
      const token = await gcsToken();
      const resp = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(STATE_OBJECT)}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (resp.status === 404) return { ...EMPTY_STATE };
      if (!resp.ok) throw new Error(`GCS read failed: ${resp.status}`);
      return { ...EMPTY_STATE, ...(await resp.json()) };
    } catch (err) {
      console.error('State load from GCS failed:', err.message);
      throw err;
    }
  }
  try {
    if (!fs.existsSync(STATE_FILE)) return { ...EMPTY_STATE };
    return { ...EMPTY_STATE, ...JSON.parse(await fs.promises.readFile(STATE_FILE, 'utf8')) };
  } catch (err) {
    console.warn('State file unreadable, starting empty:', err.message);
    return { ...EMPTY_STATE };
  }
}

async function saveState(state) {
  if (GCS_BUCKET) {
    const token = await gcsToken();
    const resp = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o?uploadType=media&name=${encodeURIComponent(STATE_OBJECT)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      }
    );
    if (!resp.ok) throw new Error(`GCS write failed: ${resp.status}`);
    return;
  }
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/* =========================== Trend sources =========================== */

async function fetchGoogleTrends(geo = 'US') {
  try {
    const resp = await fetch(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    return xml.split('<item>').slice(1)
      .map(chunk => {
        const m = chunk.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
        return m ? m[1].trim() : null;
      })
      .filter(Boolean)
      .slice(0, 15);
  } catch (err) {
    console.warn('Google Trends fetch failed:', err.message);
    return [];
  }
}

async function getRedditToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const auth = Buffer.from(`${id}:${secret}`).toString('base64');
    const resp = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'OmniStudio:trend-watch:v1'
      },
      body: 'grant_type=client_credentials'
    });
    if (!resp.ok) return null;
    return (await resp.json()).access_token || null;
  } catch {
    return null;
  }
}

async function fetchRedditHot(subreddit) {
  if (!subreddit) return [];
  const clean = subreddit.replace(/^\/?r\//, '').replace(/[^a-zA-Z0-9_]/g, '');
  const token = await getRedditToken();
  const base = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const headers = { 'User-Agent': 'OmniStudio:trend-watch:v1 (by /u/omnistudio)' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const resp = await fetch(`${base}/r/${clean}/hot.json?limit=12`, { headers });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data?.children || []).map(c => c.data?.title).filter(Boolean).slice(0, 12);
  } catch (err) {
    console.warn('Reddit fetch failed:', err.message);
    return [];
  }
}

async function fetchYouTubePopular(regionCode = 'US') {
  const key = process.env.YOUTUBE_API_KEY || GEMINI_API_KEY;
  try {
    const resp = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&maxResults=12&regionCode=${regionCode}&key=${key}`
    );
    if (!resp.ok) return { titles: [], error: `YouTube API unavailable (${resp.status})` };
    const data = await resp.json();
    return { titles: (data.items || []).map(i => i.snippet?.title).filter(Boolean).slice(0, 12), error: null };
  } catch (err) {
    return { titles: [], error: err.message };
  }
}

/* =========================== Ideas agent =========================== */

async function suggestIdeasForChannel({ channelName, platform = 'youtube', niche, count = 3, existingTitles = [], subreddit = '', geo = 'US' }) {
  if (!niche || !niche.trim()) throw new Error('Channel niche is required');

  const [googleTrends, reddit, youtube] = await Promise.all([
    fetchGoogleTrends(geo),
    fetchRedditHot(subreddit),
    fetchYouTubePopular(geo)
  ]);
  const parts = [];
  if (googleTrends.length) parts.push(`Google Trends (today): ${googleTrends.join('; ')}`);
  if (youtube.titles.length) parts.push(`YouTube most popular now: ${youtube.titles.join('; ')}`);
  if (reddit.length) parts.push(`Reddit r/${subreddit.replace(/^\/?r\//, '')} hot posts: ${reddit.join('; ')}`);
  const trendsBlock = parts.length
    ? `\nLIVE TREND SIGNALS (only trend-jack where it authentically fits the niche; never force an unrelated trend):\n${parts.join('\n')}\n`
    : '';

  const platformNotes = platform === 'instagram'
    ? 'Instagram Reels: vertical short-form under 90s. The spoken/visual hook must land in 1-2 seconds with no intro; optimize for completion, shares, comments, and profile conversion.'
    : 'YouTube: long-form earns the click through a one-idea title/thumbnail conversation and holds attention through visual progression; Shorts win through an immediate spoken/visual hook and completion rate.';

  const systemPrompt = `
You are a viral content strategist for AI-generated video channels.
Today's date: ${new Date().toDateString()} — factor in the season and upcoming events.

Channel: "${channelName || 'Unnamed channel'}"
Platform: ${platform}. ${platformNotes}
Niche: "${niche}"
${trendsBlock}
${existingTitles.length > 0 ? `Already planned/published (do NOT duplicate these):\n${existingTitles.map(t => `- ${t}`).join('\n')}` : ''}

Suggest exactly ${count} video ideas with strong viral potential for this niche.
Prioritize: evergreen search demand, seasonal relevance right now, curiosity-gap hooks,
and topics that AI-generated visuals can portray well (no celebrity likenesses, no news events
requiring real footage).

Apply these content laws:
- Pick one core idea and twist its angle through contrast, mystery, unexpected change, personal tension, or urgency.
- The title promises the reward; the thumbnail should add a different visual question, never repeat the title.
- The hook is the exact first spoken line plus first visual action, with no greeting or setup.
- Structure beats as Hook/Problem → escalating Value/Solution → concrete Payoff/CTA bridge.
- Keep language simple, clear, and relatable, with visible demonstrations and progression.
- Long-form ideas should be exceptional anchor concepts that can feed multiple hook-led Shorts.

For each idea return:
- "title": CTR-optimized title (under 60 chars).
- "topic": one-sentence description of the video content.
- "format": "long", "short", or "reel" (fit the platform).
- "hook": the exact first spoken line plus simultaneous first visual action that stops the scroll.
- "angle": the unique framing that differentiates this video from generic takes on the topic.
- "keyPoints": 3-5 concrete visual-story beats in order: problem, escalation/evidence, solution,
  payoff, and where appropriate a bridge to the next video or viewer action.
- "targetAudience": one phrase describing exactly who this is for (age, interest, intent).
- "whyViral": one sentence on why this can perform (search volume, trend, emotion, shareability).
- "videoPrompt": a ready-to-paste prompt describing the hook shot, visual progression, pattern interrupts,
  final payoff, format/orientation, and consistent visual style.
- "bestPostTime": day + time suggestion for this audience.
- "hashtags": 3-5 hashtags.
- "roiPotential": "high", "medium" or "low" — expected payoff relative to production effort.
- "roiEstimatedViews": realistic first-30-days view range for a SMALL/NEW channel in this niche. Be conservative.
- "roiEstimatedRevenue": rough ad-revenue range at this niche's typical RPM, noting the basis.
  For Shorts/Reels, say the value is mainly channel growth, not direct revenue.
- "roiRationale": one sentence: demand vs competition vs production effort.
Also return "strategyNote": 1-2 sentences on the overall content strategy for this channel right now.
These ROI figures are honest speculative estimates to compare ideas — not guarantees.

Generate the output conforming to the response schema.
`;

  const requestBody = {
    contents: [{ parts: [{ text: systemPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          strategyNote: { type: 'STRING' },
          ideas: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING' },
                topic: { type: 'STRING' },
                format: { type: 'STRING' },
                hook: { type: 'STRING' },
                angle: { type: 'STRING' },
                keyPoints: { type: 'ARRAY', items: { type: 'STRING' } },
                targetAudience: { type: 'STRING' },
                whyViral: { type: 'STRING' },
                videoPrompt: { type: 'STRING' },
                bestPostTime: { type: 'STRING' },
                hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
                roiPotential: { type: 'STRING' },
                roiEstimatedViews: { type: 'STRING' },
                roiEstimatedRevenue: { type: 'STRING' },
                roiRationale: { type: 'STRING' }
              },
              required: ['title', 'topic', 'format', 'hook', 'angle', 'keyPoints', 'targetAudience', 'whyViral', 'videoPrompt', 'bestPostTime', 'hashtags', 'roiPotential', 'roiEstimatedViews', 'roiEstimatedRevenue', 'roiRationale']
            }
          }
        },
        required: ['strategyNote', 'ideas']
      }
    }
  };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini suggestion failed: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

/* =========================== Digest email =========================== */

function buildDigestHtml(digest) {
  const when = new Date(digest.at).toLocaleString();
  const sections = digest.channels.map(ch => {
    if (ch.error) return `<h3>${ch.channelName}</h3><p style="color:#b45309">Run failed: ${ch.error}</p>`;
    const rows = ch.ideas.map(i => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;"><strong>${i.title}</strong><br>
            <span style="color:#555;font-size:13px;">${i.whyViral || ''}</span></td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap;">${i.format}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap;">
            ${i.roi ? `${i.roi.potential.toUpperCase()}<br><span style="color:#555;font-size:12px;">${[i.roi.views, i.roi.revenue].filter(Boolean).join(' → ')}</span>` : '—'}</td>
      </tr>`).join('');
    return `
      <h3 style="margin:18px 0 4px;">${ch.channelName}</h3>
      ${ch.strategyNote ? `<p style="color:#555;margin:0 0 8px;">${ch.strategyNote}</p>` : ''}
      <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;">
        <tr><th align="left" style="padding:6px 10px;">Idea</th><th align="left" style="padding:6px 10px;">Format</th><th align="left" style="padding:6px 10px;">Est. ROI</th></tr>
        ${rows || '<tr><td colspan="3" style="padding:6px 10px;color:#777;">No new ideas this run.</td></tr>'}
      </table>`;
  }).join('');

  return `
  <div style="font-family:sans-serif;max-width:640px;">
    <h2>OmniStudio Trend Watch (Cloud)</h2>
    <p>${when} — <strong>${digest.totalNewIdeas} new video ideas</strong> waiting in your planner.
       Open OmniStudio locally and the planner will sync them automatically.</p>
    ${sections}
    <p style="color:#888;font-size:12px;margin-top:16px;">ROI figures are AI estimates for a new/small channel — for comparing ideas, not guarantees.</p>
  </div>`;
}

async function sendDigestEmail(digest) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, DIGEST_EMAIL_TO } = process.env;
  if (!SMTP_HOST || !DIGEST_EMAIL_TO) return false;
  try {
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT || '587', 10),
      secure: SMTP_PORT === '465',
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
    });
    await transporter.sendMail({
      from: SMTP_USER || 'trend-watch@omnistudio',
      to: DIGEST_EMAIL_TO,
      subject: `OmniStudio Trend Watch: ${digest.totalNewIdeas} new video ideas`,
      html: buildDigestHtml(digest)
    });
    console.log(`Digest emailed to ${DIGEST_EMAIL_TO}`);
    return true;
  } catch (err) {
    console.warn('Digest email failed:', err.message);
    return false;
  }
}

/* =========================== Agent run =========================== */

let running = false;

async function runTrendWatch(trigger = 'schedule') {
  if (running) return { ok: false, message: 'A run is already in progress' };
  running = true;
  try {
    const state = await loadState();
    if (state.channels.length === 0) {
      return { ok: false, message: 'No channels synced yet — open the OmniStudio planner once to push them' };
    }

    console.log(`Trend Watch run (${trigger}) for ${state.channels.length} channel(s)...`);
    const digest = { id: `dg_${Date.now()}`, at: Date.now(), trigger, channels: [], totalNewIdeas: 0, emailed: false };

    for (const ch of state.channels) {
      try {
        const known = new Set([
          ...(ch.knownTitles || []),
          ...state.pendingIdeas.filter(v => v.channelId === ch.id).map(v => v.title)
        ].map(t => t.toLowerCase()));

        const result = await suggestIdeasForChannel({
          channelName: ch.name,
          platform: ch.platform,
          niche: ch.niche,
          count: 3,
          existingTitles: [...known].slice(0, 60),
          subreddit: ch.subreddit || ''
        });

        const newIdeas = (result.ideas || [])
          .filter(i => i.title && !known.has(i.title.toLowerCase()))
          .map(idea => ({
            id: `tw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            channelId: ch.id,
            title: idea.title,
            topic: idea.topic,
            format: ['long', 'short', 'reel'].includes(idea.format) ? idea.format : (ch.platform === 'instagram' ? 'reel' : 'long'),
            status: 'idea',
            scheduledDate: '',
            hook: idea.hook,
            angle: idea.angle || '',
            keyPoints: (idea.keyPoints || []).filter(Boolean),
            targetAudience: idea.targetAudience || '',
            whyViral: idea.whyViral,
            videoPrompt: idea.videoPrompt,
            bestPostTime: idea.bestPostTime,
            hashtags: idea.hashtags,
            roi: {
              potential: ['high', 'medium', 'low'].includes((idea.roiPotential || '').toLowerCase()) ? idea.roiPotential.toLowerCase() : 'medium',
              views: idea.roiEstimatedViews || '',
              revenue: idea.roiEstimatedRevenue || '',
              rationale: idea.roiRationale || ''
            },
            source: 'watch',
            createdAt: Date.now()
          }));

        state.pendingIdeas.push(...newIdeas);
        ch.knownTitles = [...(ch.knownTitles || []), ...newIdeas.map(v => v.title)].slice(-200);
        digest.channels.push({
          channelId: ch.id,
          channelName: ch.name,
          strategyNote: result.strategyNote || '',
          ideas: newIdeas.map(v => ({ title: v.title, format: v.format, roi: v.roi, whyViral: v.whyViral }))
        });
        digest.totalNewIdeas += newIdeas.length;
      } catch (err) {
        console.warn(`Channel "${ch.name}" failed: ${err.message}`);
        digest.channels.push({ channelId: ch.id, channelName: ch.name, error: err.message, ideas: [] });
      }
    }

    digest.emailed = await sendDigestEmail(digest);
    state.digests = [digest, ...(state.digests || [])].slice(0, 20);
    state.lastRun = digest.at;
    await saveState(state);

    console.log(`Run done: ${digest.totalNewIdeas} new ideas pending (emailed: ${digest.emailed})`);
    return { ok: true, digest };
  } finally {
    running = false;
  }
}

/* =========================== HTTP API =========================== */

// All endpoints except /health require the shared secret
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (AGENT_SECRET && req.headers['x-agent-secret'] !== AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', async (req, res) => {
  res.json({ ok: true, service: 'trend-watch', storage: GCS_BUCKET ? `gcs:${GCS_BUCKET}` : 'file' });
});

// Local app pushes its channel list (with titles it already has, for dedupe)
app.put('/channels', async (req, res) => {
  try {
    const { channels = [] } = req.body;
    const state = await loadState();
    // Preserve knownTitles learned by previous runs, merge with what the app sends
    state.channels = channels.map(ch => {
      const prev = state.channels.find(c => c.id === ch.id);
      const merged = new Set([...(prev?.knownTitles || []), ...(ch.knownTitles || [])]);
      return { id: ch.id, name: ch.name, platform: ch.platform, niche: ch.niche, subreddit: ch.subreddit || '', knownTitles: [...merged].slice(-200) };
    });
    await saveState(state);
    res.json({ success: true, channels: state.channels.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Local app pulls pending ideas + recent digests
app.get('/state', async (req, res) => {
  try {
    const state = await loadState();
    res.json({
      lastRun: state.lastRun,
      running,
      channels: state.channels.length,
      pendingIdeas: state.pendingIdeas,
      digests: (state.digests || []).slice(0, 5)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Local app acknowledges imported ideas so they aren't delivered twice
app.post('/ack', async (req, res) => {
  try {
    const { ids = [] } = req.body;
    const state = await loadState();
    const before = state.pendingIdeas.length;
    state.pendingIdeas = state.pendingIdeas.filter(v => !ids.includes(v.id));
    await saveState(state);
    res.json({ success: true, removed: before - state.pendingIdeas.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cloud Scheduler (or manual) trigger
app.post('/run', async (req, res) => {
  try {
    const result = await runTrendWatch(req.headers['x-cloudscheduler'] ? 'schedule' : 'manual');
    if (!result.ok) return res.status(409).json({ error: result.message });
    res.json(result);
  } catch (err) {
    console.error('Run failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Trend Watch service on port ${PORT} (storage: ${GCS_BUCKET ? `gcs://${GCS_BUCKET}/${STATE_OBJECT}` : STATE_FILE})`);
  if (RUN_INTERVAL_HOURS > 0) {
    const ms = Math.max(1, Math.min(48, RUN_INTERVAL_HOURS)) * 3600 * 1000;
    setInterval(() => runTrendWatch('interval').catch(e => console.error('Interval run failed:', e)), ms);
    console.log(`Internal interval mode: every ${RUN_INTERVAL_HOURS}h (use Cloud Scheduler instead on Cloud Run)`);
  }
});
