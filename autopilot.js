// Autopilot: a server-side job queue that produces a complete video hands-free,
// with two pipelines chosen by the channel's content type:
//   explainer — script → music bed → TTS narration → scenes → realism → render
//   music     — Lyria song → timed lyric transcription → lyric storyboard with
//               the channel's preset character → scenes → realism → render
// Both end the same way: separate subtitle captions + logo watermark, SEO +
// chapters, brand thumbnail, cloud library archive, and a YouTube upload
// scheduled to go public at the chosen slot (publishAt).
//
// The queue reuses the app's own HTTP endpoints (self-calls on localhost), so
// every pipeline improvement automatically benefits Autopilot. Jobs run one at
// a time, survive restarts as records (an interrupted run is marked failed and
// can be retried), and update the linked Planner row when they finish.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, '.autopilot-queue.json');

let jobs = [];
let busy = false;
let autoScanBusy = false;
const stoppedChannelIds = new Set();
let deps = null; // { outputsDir, loadPlannerData, savePlannerData, baseUrl }
const autopilotPaused = /^(1|true|yes)$/i.test(process.env.AUTOPILOT_PAUSED || '');
let drainMode = false;

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_PATH)) jobs = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  } catch (err) {
    console.warn('Autopilot queue load failed:', err.message);
    jobs = [];
  }
  // A job left "running" means the server died mid-pipeline — surface that honestly
  jobs.forEach(j => {
    if (j.status === 'running') {
      j.status = 'failed';
      j.error = 'Interrupted by a server restart — resume from the saved progress.';
    } else if (j.error === 'Interrupted by a server restart — retry to run it again.') {
      j.error = 'Interrupted by a server restart — resume from the saved progress.';
    }
  });
}

function saveQueue() {
  try {
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(jobs, null, 2));
  } catch (err) {
    console.warn('Autopilot queue save failed:', err.message);
  }
}

function log(job, msg) {
  job.log.push({ t: Date.now(), msg });
  if (job.log.length > 200) job.log.shift();
  console.log(`[autopilot ${job.id}] ${msg}`);
  saveQueue();
}

async function api(route, body) {
  const res = await fetch(`${deps.baseUrl()}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${route} failed (${res.status})`);
  return data;
}

function timeToSec(t) {
  if (!t) return 0;
  const [m, s] = String(t).split(':');
  return (parseInt(m, 10) || 0) * 60 + (parseFloat(s) || 0);
}

function stampMMSS(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function srtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// Chapters honoring YouTube's rules (00:00 first, ≥10s each, absorb short segments)
function buildChapters(introDur, scenes, outroDur) {
  const candidates = [];
  if (introDur > 0) candidates.push({ t: 0, title: 'Intro' });
  let t = introDur;
  scenes.forEach((s, i) => {
    const src = (s.narration || s.prompt || `Scene ${i + 1}`).replace(/\s+/g, ' ').trim();
    const words = src.split(' ');
    const title = words.slice(0, 6).join(' ').replace(/[.,;:!?]+$/, '') + (words.length > 6 ? '…' : '');
    candidates.push({ t, title });
    t += s.duration;
  });
  if (outroDur > 0) candidates.push({ t, title: 'Outro — Subscribe!' });

  const chapters = [];
  candidates.forEach(c => {
    if (chapters.length === 0) { chapters.push({ t: 0, title: c.title }); return; }
    const prev = chapters[chapters.length - 1];
    if (c.t - prev.t < 10) { if (prev.title === 'Intro') prev.title = c.title; return; }
    chapters.push({ ...c });
  });
  return chapters.map(c => `${stampMMSS(c.t)} ${c.title}`).join('\n');
}

// Channel brand-kit files → data URLs (style refs for scenes & thumbnail)
function brandRefDataUrls(channel) {
  const refs = [];
  const files = [...new Set([channel && channel.logo, ...((channel && channel.brandRefs) || [])].filter(Boolean))];
  for (const f of files) {
    try {
      const p = path.join(deps.outputsDir, f);
      if (fs.existsSync(p)) {
        const ext = path.extname(f).slice(1).replace('jpg', 'jpeg') || 'png';
        refs.push(`data:image/${ext};base64,${fs.readFileSync(p).toString('base64')}`);
      }
    } catch { /* skip unreadable refs */ }
  }
  return refs.slice(0, 4);
}

const PIPELINES = {
  explainer: ['script', 'music', 'narration', 'scenes', 'realism', 'render', 'seo', 'thumbnail', 'upload'],
  music: ['song', 'lyrics', 'storyboard', 'scenes', 'realism', 'render', 'seo', 'thumbnail', 'upload']
};

function pipelineSteps(job) {
  return PIPELINES[job.pipeline] || PIPELINES.explainer;
}

// Music channels get the song pipeline; explicit contentType wins over inference
// (mirrors channelIsMusic in the client)
function isMusicChannel(ch) {
  if (!ch) return false;
  if (ch.contentType) return ch.contentType === 'music';
  return /song|music|rhyme|lullab|sing|tunes/i.test(`${ch.niche || ''} ${ch.name || ''}`);
}

function setStep(job, step) {
  const steps = pipelineSteps(job);
  job.step = step;
  job.progress = { index: steps.indexOf(step) + 1, total: steps.length };
  saveQueue();
}

function cancelled(job) {
  return job.status === 'cancelled';
}

function outputExists(filename) {
  return typeof filename === 'string'
    && path.basename(filename) === filename
    && fs.existsSync(path.join(deps.outputsDir, filename));
}

/* ------------------- Shared pipeline building blocks ------------------- */

// 4. Scenes (sequential, with background continuity + optional star character)
async function generateScenes(job, refs, characterName) {
  const o = job.options;
  const a = job.artifacts;
  setStep(job, 'scenes');
  let prevInteractionId = null;
  let prevFilename = null;
  for (const scene of a.scenes) {
    if (cancelled(job)) return;
    if (outputExists(scene.filename)) {
      prevFilename = scene.filename;
      log(job, `Scene ${scene.index + 1}/${a.scenes.length} already exists — keeping it.`);
      continue;
    }
    log(job, `Generating scene ${scene.index + 1}/${a.scenes.length}…`);
    const result = await api('/api/generate-scene', {
      sceneDescription: scene.prompt,
      sceneIndex: scene.index,
      characterName: characterName || undefined,
      images: refs.length ? refs : undefined,
      previousInteractionId: !scene.newBackground ? prevInteractionId : null,
      previousSceneFilename: prevFilename,
      aspectRatio: o.orientation === 'vertical' ? '9:16' : '16:9'
    });
    scene.filename = result.filename;
    prevInteractionId = result.interactionId || null;
    prevFilename = result.filename;
    log(job, `Scene ${scene.index + 1} done: ${result.filename}`);
  }
  log(job, `All ${a.scenes.length} scene clips generated.`);
  if (deps.notify) {
    deps.notify({
      title: '🎬 OmniStudio: All Scenes Generated',
      message: `All ${a.scenes.length} scene clips for "${a.videoTitle || job.topic}" are ready!`
    }).catch(() => {});
  }
}

// 5. Realism pass (optional; one fix attempt per scene)
async function realismPass(job, refs, characterName) {
  const o = job.options;
  const a = job.artifacts;
  setStep(job, 'realism');
  if (!o.realismCheck) { log(job, 'Realism pass skipped.'); return; }
  for (const scene of a.scenes) {
    if (cancelled(job)) return;
    const realismComplete = scene.realismReviewed || scene.realismFixed || scene.realismScore >= 6;
    if (realismComplete && outputExists(scene.filename)) {
      log(job, `Scene ${scene.index + 1} realism already completed (${scene.realismScore}/10) — keeping it.`);
      continue;
    }
    try {
      const review = await api('/api/review-video-realism', { filename: scene.filename, prompt: scene.prompt });
      scene.realismScore = review.realismScore;
      if (review.realismScore < 6 && review.suggestedFix) {
        log(job, `Scene ${scene.index + 1} scored ${review.realismScore}/10 — regenerating with the suggested fix.`);
        const redo = await api('/api/generate-scene', {
          sceneDescription: `${scene.prompt}. ${review.suggestedFix}`,
          sceneIndex: scene.index,
          characterName: characterName || undefined,
          images: refs.length ? refs : undefined,
          previousSceneFilename: scene.index > 0 ? a.scenes[scene.index - 1].filename : null,
          aspectRatio: o.orientation === 'vertical' ? '9:16' : '16:9'
        });
        scene.filename = redo.filename;
        scene.realismFixed = true;
        scene.realismReviewed = true;
        log(job, `Scene ${scene.index + 1} realism fix completed.`);
      } else {
        scene.realismReviewed = true;
        log(job, `Scene ${scene.index + 1} realism: ${review.realismScore}/10 ✓`);
      }
    } catch (err) {
      log(job, `Realism check for scene ${scene.index + 1} failed (${err.message}) — keeping the clip.`);
    }
  }
}

// 6-9. SEO/card package → render master → thumbnail → archive → scheduled upload.
// Identical for both pipelines; only the audio tracks, subtitle lines and SEO
// context differ.
async function renderAndPublish(job, channel, { audioFilename, narrationFilename, subtitleLines, seoParams, thumbRefs }) {
  const o = job.options;
  const a = job.artifacts;

  const cd = (channel && channel.defaults) || {};
  const introDur = cd.introDuration !== undefined ? cd.introDuration : (parseFloat(o.introDuration) || 4);
  const outroDur = cd.outroDuration !== undefined ? cd.outroDuration : (parseFloat(o.outroDuration) || 4);

  // 6. Generate the packaging before render so contextual cards are part of the master.
  setStep(job, 'seo');
  if (a.seo && a.seo.introCardTitle && a.seo.outroCardCTA) {
    log(job, 'SEO and contextual card package already exist — keeping them.');
  } else {
    log(job, 'Generating SEO and the contextual card package…');
    a.seo = await api('/api/generate-seo', seoParams);
  }
  a.chapters = buildChapters(introDur, a.scenes, outroDur);

  for (const which of ['intro', 'outro']) {
    const artifactKey = `${which}CardImageFilename`;
    if (outputExists(a[artifactKey])) continue;
    const promptKey = which === 'intro' ? 'introBackgroundPrompt' : 'outroBackgroundPrompt';
    const titleKey = which === 'intro' ? 'introCardTitle' : 'outroCardTitle';
    const subtitleKey = which === 'intro' ? 'introCardSubtitle' : 'outroCardCTA';
    log(job, `Generating the contextual ${which} card background…`);
    const image = await api('/api/generate-thumbnail', {
      concept: a.seo[promptKey],
      videoTitle: a.seo[titleKey],
      seoTitle: (a.seo.titles && a.seo.titles[0]) || a.videoTitle,
      cardRole: which,
      cardTitle: a.seo[titleKey],
      cardSubtitle: a.seo[subtitleKey],
      channelName: channel ? channel.name : '',
      channelNiche: channel ? (channel.niche || channel.description || '') : '',
      orientation: o.orientation === 'vertical' ? 'vertical' : 'landscape',
      kind: 'card-bg',
      referenceImages: thumbRefs || []
    });
    a[artifactKey] = image.filename;
  }
  log(job, 'SEO, chapters, and contextual cards ready.');
  if (cancelled(job)) return;

  // 7. Render the master (cards, subtitles, logo watermark, polish)
  setStep(job, 'render');
  if (outputExists(a.renderFilename)) {
    log(job, `Master render already exists — keeping ${a.renderFilename}.`);
  } else {
    log(job, 'Rendering the master video…');
    const render = await api('/api/compile-studio-video', {
      audioFilename: audioFilename || null,
      narrationFilename: narrationFilename || null,
      scenes: a.scenes.map(s => ({ filename: s.filename, duration: s.duration })),
      lyrics: subtitleLines,
      subtitleStyle: { position: 'bottom', fontSize: 32, fontColor: '#ffffff', strokeColor: '#000000', bgBox: true },
      introCard: {
        enabled: true,
        title: a.seo.introCardTitle,
        subtitle: a.seo.introCardSubtitle,
        imageFilename: a.introCardImageFilename,
        imageMode: 'background',
        kenBurns: false,
        hideText: true,
        duration: introDur
      },
      outroCard: {
        enabled: true,
        title: a.seo.outroCardTitle,
        ctaText: a.seo.outroCardCTA,
        imageFilename: a.outroCardImageFilename,
        imageMode: 'background',
        kenBurns: false,
        hideText: true,
        duration: outroDur
      },
      orientation: o.orientation === 'vertical' ? 'vertical' : 'landscape',
      logo: channel && channel.logo
        ? { filename: channel.logo, position: 'top-right', size: 0.12, opacity: 0.85 }
        : null,
      polish: {
        transition: 'fade', transitionDuration: 0.5,
        musicFadeIn: true, fadeInDuration: 2,
        audioFadeOut: true, loudnorm: true, videoFadeOut: false
      }
    });
    a.renderFilename = render.filename;
    log(job, `Master rendered: ${render.filename}`);
  }
  if (cancelled(job)) return;

  // 8. Thumbnail
  setStep(job, 'thumbnail');
  if (outputExists(a.thumbnailFilename)) {
    log(job, `Thumbnail already exists — keeping ${a.thumbnailFilename}.`);
  } else try {
    const concept = (a.seo && a.seo.thumbnailIdeas && a.seo.thumbnailIdeas[0]) || `Eye-catching thumbnail for: ${a.videoTitle}`;
    log(job, 'Generating the thumbnail…');
    const thumb = await api('/api/generate-thumbnail', {
      concept: typeof concept === 'string' ? concept : JSON.stringify(concept),
      videoTitle: a.videoTitle,
      orientation: o.orientation === 'vertical' ? 'vertical' : 'landscape',
      kind: 'thumbnail',
      referenceImages: thumbRefs || []
    });
    a.thumbnailFilename = thumb.filename;
    log(job, 'Thumbnail ready.');
  } catch (err) {
    log(job, `Thumbnail failed (${err.message}) — continuing without it.`);
  }
  if (cancelled(job)) return;

  // Deliverables ready — archive them to the organized cloud library (best-effort):
  // library/<channel>/<date>_<title>/{master.mp4, thumbnail, subtitles.srt, metadata}
  const srt = subtitleLines.map((l, i) =>
    `${i + 1}\n${srtTime(introDur + l.startTime)} --> ${srtTime(introDur + l.startTime + l.duration)}\n${l.text}\n`
  ).join('\n');
  try {
    const arch = await api('/api/archive-render', {
      channelName: job.channelName || '',
      title: a.videoTitle,
      videoFilename: a.renderFilename,
      thumbnailFilenames: a.thumbnailFilename ? [a.thumbnailFilename] : [],
      srtContent: srt,
      metadataContent: [
        `TITLE: ${(a.seo && a.seo.titles && a.seo.titles[0]) || a.videoTitle}`,
        '', 'DESCRIPTION:', (a.seo && a.seo.description) || '',
        '', 'TAGS:', ((a.seo && a.seo.tags) || []).join(', '),
        '', 'CHAPTERS:', a.chapters || '',
        '', 'OPENING HOOK:', (a.seo && a.seo.openingHook) || '',
        '', 'PINNED COMMENT:', (a.seo && a.seo.pinnedComment) || '',
        '', 'END-SCREEN BRIDGE:', (a.seo && a.seo.endScreenBridge) || '',
        '', 'SHORT-FORM HOOKS:', ((a.seo && a.seo.shortsHooks) || []).join('\n')
      ].join('\n')
    });
    if (arch.archived) {
      a.libraryPath = arch.path;
      log(job, `Archived ${arch.archived} file(s) → ${arch.path}`);
    }
  } catch (err) {
    log(job, `Cloud library archive skipped: ${err.message}`);
  }

  // 9. Upload to YouTube, scheduled for the slot
  setStep(job, 'upload');
  if (a.youtube && a.youtube.url) {
    log(job, `YouTube upload already completed: ${a.youtube.url}`);
    job.status = 'done';
  } else if (o.uploadToYouTube) {
    const status = await fetch(`${deps.baseUrl()}/api/youtube/status?channelId=${encodeURIComponent(job.channelId || '')}`).then(r => r.json()).catch(() => ({}));
    if (!status.connected) {
      log(job, 'YouTube is not connected — assets are ready for manual upload.');
      job.status = 'ready';
    } else {
      const title = (a.seo && a.seo.titles && a.seo.titles[0]) || a.videoTitle;
      let description = (a.seo && a.seo.description) || `${a.videoTitle}\n\nMade with OmniStudio.`;
      if (a.chapters && !description.includes(a.chapters.split('\n')[0])) {
        description = `${description.trim()}\n\nCHAPTERS:\n${a.chapters}`;
      }

      log(job, `Uploading to YouTube (goes public ${o.publishAt || 'manually'})…`);
      const up = await api('/api/youtube/upload', {
        channelId: job.channelId,
        videoFilename: a.renderFilename,
        title,
        description: description.slice(0, 4900),
        tags: (a.seo && a.seo.tags) || [],
        privacyStatus: 'private',
        publishAt: o.publishAt || null,
        thumbnailFilename: a.thumbnailFilename || null,
        captionSrt: srt,
        captionLanguage: 'en'
      });
      a.youtube = { videoId: up.videoId, url: up.url, publishAt: up.publishAt };
      log(job, `Uploaded: ${up.url}${up.publishAt ? ` — goes public ${up.publishAt}` : ''}`);
      job.status = 'done';
    }
  } else {
    log(job, 'Upload skipped — assets are ready.');
    job.status = 'ready';
  }

  // Reflect the outcome on the linked Planner row
  if (job.plannerVideoId) {
    try {
      const fresh = await deps.loadPlannerData();
      const row = fresh.videos.find(v => v.id === job.plannerVideoId);
      if (row) {
        row.status = a.youtube ? 'scheduled' : 'ready';
        if (a.youtube) {
          row.publishedUrl = a.youtube.url;
          row.scheduledDate = o.publishAt || '';
        }
        await deps.savePlannerData(fresh);
      }
    } catch (err) {
      log(job, `Planner row update failed: ${err.message}`);
    }
  }
}

/* --------------------------- Explainer pipeline --------------------------- */

async function runExplainerJob(job, channel, styleRefs) {
  const o = job.options;
  const a = job.artifacts;

  // 1. Script — use the channel's configured visual style when set
  setStep(job, 'script');
  if (a.videoTitle && Array.isArray(a.scenes) && a.scenes.length) {
    log(job, `Script already exists — keeping ${a.scenes.length} scenes.`);
  } else {
    const channelStyle = channel && channel.defaults && channel.defaults.visualStyle;
    log(job, `Writing the script for "${job.topic}" (${o.durationSeconds}s)${channelStyle ? ` in "${channelStyle.split(',')[0]}" style` : ''}…`);
    const plan = await api('/api/generate-explainer-script', {
      topic: job.topic,
      durationSeconds: o.durationSeconds,
      brief: job.brief || null,
      ...(channelStyle ? { style: channelStyle } : {})
    });
    a.videoTitle = plan.videoTitle || job.title;
    a.musicPrompt = plan.musicPrompt || '';
    a.scenes = (plan.scenes || []).map((s, i) => ({
      index: i,
      prompt: s.prompt,
      narration: s.narration,
      newBackground: !!s.newBackground,
      start: s.start,
      end: s.end,
      duration: Math.max(2, timeToSec(s.end) - timeToSec(s.start))
    }));
    log(job, `Script ready: "${a.videoTitle}" — ${a.scenes.length} scenes.`);
  }
  if (a.scenes.length === 0) throw new Error('The script agent returned no scenes');
  if (cancelled(job)) return;

  // 2. Background music (optional)
  setStep(job, 'music');
  if (outputExists(a.musicFilename)) {
    log(job, `Music bed already exists — keeping ${a.musicFilename}.`);
  } else if (o.withMusic && a.musicPrompt) {
    log(job, `Generating background music: "${a.musicPrompt.slice(0, 80)}…"`);
    try {
      const totalSceneDur = a.scenes.reduce((sum, s) => sum + Math.max(0.5, (timeToSec(s.end) - timeToSec(s.start)) || 10), 0);
      const musicDur = Math.max(totalSceneDur, o.durationSeconds || 60);
      const music = await api('/api/generate-music', { prompt: a.musicPrompt, durationSeconds: musicDur });
      a.musicFilename = music.filename;
      log(job, `Music bed ready (${music.engine}).`);
    } catch (err) {
      log(job, `Music failed (${err.message}) — continuing without it.`);
    }
  } else {
    log(job, 'Music skipped.');
  }
  if (cancelled(job)) return;

  // 3. TTS narration
  setStep(job, 'narration');
  const cd = (channel && channel.defaults) || {};
  const voice = o.voice || cd.voice || 'Puck';
  const lines = a.scenes.map(s => ({ text: s.narration, startTime: timeToSec(s.start) }));
  if (outputExists(a.narrationFilename)) {
    log(job, `Voiceover already exists — keeping ${a.narrationFilename}.`);
  } else {
    log(job, `Synthesizing ${lines.length} narration lines (voice: ${voice})…`);
    const narr = await api('/api/generate-narration', { lines, voice });
    a.narrationFilename = narr.filename;
    log(job, `Voiceover ready (${narr.engine}).`);
  }
  if (cancelled(job)) return;

  await generateScenes(job, styleRefs, null);
  if (cancelled(job)) return;
  await realismPass(job, styleRefs, null);
  if (cancelled(job)) return;

  await renderAndPublish(job, channel, {
    audioFilename: a.musicFilename,
    narrationFilename: a.narrationFilename,
    subtitleLines: a.scenes.map(s => ({ text: s.narration, startTime: timeToSec(s.start), duration: s.duration })),
    seoParams: {
      topic: job.topic,
      durationSeconds: o.durationSeconds,
      sceneCount: a.scenes.length,
      videoType: 'explainer',
      scenePrompts: a.scenes.map(s => s.prompt)
    },
    thumbRefs: styleRefs
  });
}

/* ----------------------------- Music pipeline ----------------------------- */

// Idea brief → Lyria-ready song description
function buildSongPrompt(job, channel) {
  const b = job.brief || {};
  const kp = (b.keyPoints || []).filter(Boolean);
  let p = `Compose an entirely original song from this theme: ${job.topic}. Do not reproduce or imitate any existing song title, melody, lyrics, or arrangement.`;
  if (b.hook) p += ` Open with: ${b.hook}`;
  if (kp.length) p += ` The verses should cover, in order: ${kp.join('; ')}.`;
  if (b.targetAudience) p += ` Audience: ${b.targetAudience}.`;
  if (channel && channel.niche) p += ` Style: ${channel.niche}.`;
  return p;
}

// Resolve the star character: a preset by id/name, or the first preset as default.
// Returns { name, dataUrl } (dataUrl null if the image can't be loaded).
async function resolveCharacter(option) {
  try {
    const res = await fetch(`${deps.baseUrl()}/api/presets`);
    const presets = (await res.json()).characters || [];
    if (presets.length === 0) return null;
    const wanted = String(option || '').toLowerCase();
    const preset = presets.find(p => p.id === wanted || p.name.toLowerCase() === wanted) || presets[0];
    let dataUrl = null;
    try {
      const imgRes = await fetch(`${deps.baseUrl()}/${preset.file}`);
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        dataUrl = `data:image/${preset.file.endsWith('.png') ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
      }
    } catch { /* identity still works via the name */ }
    return { name: preset.name, dataUrl };
  } catch {
    return null;
  }
}

async function runMusicJob(job, channel, styleRefs) {
  const o = job.options;
  const a = job.artifacts;

  // 1. Song (Lyria decides the natural length — never forced)
  setStep(job, 'song');
  if (outputExists(a.songFilename) && a.songDuration) {
    log(job, `Song already exists — keeping ${a.songFilename}.`);
  } else {
    const songPrompt = buildSongPrompt(job, channel);
    log(job, `Composing the song with Lyria: "${songPrompt.slice(0, 90)}…"`);
    const song = await api('/api/generate-song', { prompt: songPrompt });
    a.songFilename = song.filename;
    a.songDuration = Math.round((song.duration || 60) * 10) / 10;
    a.songPromptPolicyAdjusted = song.policyAdjusted === true;
    if (a.songPromptPolicyAdjusted) {
      log(job, 'Lyria blocked the initial brief; recovered with an original theme-only prompt.');
    }
    log(job, `Song ready: ${song.filename} (${a.songDuration}s).`);
  }
  if (cancelled(job)) return;

  // 2. Timed lyric transcription (drives karaoke subtitles + the storyboard)
  setStep(job, 'lyrics');
  if (Array.isArray(a.timedLyrics) && a.timedLyrics.length) {
    log(job, `Timed lyrics already exist — keeping ${a.timedLyrics.length} lines.`);
  } else {
    log(job, 'Transcribing the sung lyrics with timestamps…');
    const tr = await api('/api/transcribe-lyrics', { audioFilename: a.songFilename });
    a.timedLyrics = (tr.lines || []).map(l => ({
      text: l.text,
      startTime: Math.max(0, +l.startSec || 0),
      duration: Math.max(0.5, (+l.endSec || 0) - (+l.startSec || 0))
    }));
    log(job, `${a.timedLyrics.length} lyric lines transcribed.`);
  }
  if (a.timedLyrics.length === 0) throw new Error('No sung lyrics detected in the generated song');
  if (cancelled(job)) return;

  // 3. Storyboard from the lyrics, starring the channel's character
  setStep(job, 'storyboard');
  const character = await resolveCharacter(o.character);
  a.characterName = character ? character.name : 'the star character';
  if (Array.isArray(a.scenes) && a.scenes.length) {
    log(job, `Storyboard already exists — keeping ${a.scenes.length} scenes.`);
  } else {
    log(job, `Storyboarding the lyrics for ${a.characterName}…`);
    const script = await api('/api/generate-script', {
      lyrics: a.timedLyrics.map(l => l.text).join('\n'),
      characterName: a.characterName,
      durationSeconds: a.songDuration
    });
    a.scenes = (script.scenes || []).map((s, i) => ({
      index: i,
      prompt: s.prompt,
      newBackground: !!s.newBackground,
      start: s.start,
      end: s.end,
      duration: Math.max(2, timeToSec(s.end) - timeToSec(s.start))
    }));
    log(job, `Storyboard ready: ${a.scenes.length} scenes.`);
  }
  if (a.scenes.length === 0) throw new Error('The storyboard agent returned no scenes');
  if (cancelled(job)) return;

  // Character identity first, then the brand kit (same order the Studio uses)
  const refs = [...(character && character.dataUrl ? [character.dataUrl] : []), ...styleRefs].slice(0, 4);

  await generateScenes(job, refs, a.characterName);
  if (cancelled(job)) return;
  await realismPass(job, refs, a.characterName);
  if (cancelled(job)) return;

  a.videoTitle = job.title;
  await renderAndPublish(job, channel, {
    audioFilename: a.songFilename,
    narrationFilename: null,
    subtitleLines: a.timedLyrics,
    seoParams: {
      topic: null,
      lyrics: a.timedLyrics.map(l => l.text).join('\n'),
      durationSeconds: a.songDuration,
      sceneCount: a.scenes.length,
      videoType: "children's music",
      scenePrompts: a.scenes.map(s => s.prompt)
    },
    thumbRefs: refs
  });
}

async function runJob(job) {
  const data = await deps.loadPlannerData();
  const channel = data.channels.find(c => c.id === job.channelId) || null;
  const styleRefs = brandRefDataUrls(channel);
  if (job.pipeline === 'music') return runMusicJob(job, channel, styleRefs);
  return runExplainerJob(job, channel, styleRefs);
}

// Ping the user (macOS notification + optional email) about a finished job
async function notifyJobOutcome(job) {
  if (!deps.notify) return;
  const yt = job.artifacts && job.artifacts.youtube;
  let title, message;
  if (job.status === 'done' && yt) {
    title = '✅ Autopilot: video scheduled';
    message = `"${job.title}" is on YouTube (private) and goes public ${yt.publishAt ? new Date(yt.publishAt).toLocaleString() : 'manually'} — ${yt.url}`;
  } else if (job.status === 'ready') {
    title = '📦 Autopilot: assets ready';
    message = `"${job.title}" is fully produced (video, thumbnail, SEO). Open the Planner queue to review and upload.`;
  } else if (job.status === 'failed') {
    title = '❌ Autopilot: job failed';
    message = `"${job.title}" failed at step "${job.step}": ${job.error}. Retry it from the Planner queue.`;
  } else {
    return;
  }
  try { await deps.notify({ title, message }); } catch { /* best-effort */ }
}

async function workerTick() {
  if (autopilotPaused || busy) return;
  const job = jobs.find(j => j.status === 'queued');
  if (!job) return;
  busy = true;
  job.status = 'running';
  job.startedAt = Date.now();
  saveQueue();
  try {
    await runJob(job);
    if (job.status === 'running') job.status = 'done'; // safety net
    if (job.status === 'cancelled') log(job, 'Job cancelled.');
    else log(job, `Job finished: ${job.status}.`);
  } catch (err) {
    console.error(`[autopilot ${job.id}] failed:`, err.message);
    job.status = 'failed';
    job.error = err.message;
    log(job, `Failed at step "${job.step}": ${err.message}`);
  } finally {
    job.finishedAt = Date.now();
    busy = false;
    saveQueue();
    notifyJobOutcome(job);
    if (!autopilotPaused) setTimeout(() => fullAutopilotTick(), 0);
  }
}

/* ---------------- Full Autopilot: channels that produce themselves ---------------- */
//
// Channels opt in via channel.autopilot = { enabled, publishHour, options }.
// Each enabled channel always keeps one automatic job queued or running. As soon
// as it finishes, the next best unproduced idea is queued. This continues until
// the channel switch is turned off; there is no weekly or daily production cap.

const AUTO_SCAN_MS = 30 * 60 * 1000;
const ROI_RANK = { high: 3, medium: 2, low: 1 };

function makeJob({ channelId, channelName, plannerVideoId, title, topic, brief, options, pipeline = 'explainer', auto = false }) {
  return {
    id: `ap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    channelId, channelName, plannerVideoId,
    title: (title || topic).slice(0, 120),
    topic,
    brief,
    auto,
    pipeline: pipeline === 'music' ? 'music' : 'explainer',
    options: {
      durationSeconds: Math.min(300, Math.max(20, parseInt(options.durationSeconds, 10) || 60)),
      orientation: options.orientation === 'vertical' ? 'vertical' : 'landscape',
      voice: options.voice || 'Kore',
      character: options.character || null, // music pipeline: preset id/name of the star
      withMusic: options.withMusic !== false,
      burnSubtitles: options.burnSubtitles === true,
      realismCheck: options.realismCheck !== false,
      uploadToYouTube: options.uploadToYouTube !== false,
      publishAt: options.publishAt || null
    },
    status: 'queued',
    step: null,
    progress: { index: 0, total: (PIPELINES[pipeline] || PIPELINES.explainer).length },
    log: [],
    artifacts: {},
    error: null
  };
}

// Find the next free daily publish slot for a channel at its preferred hour.
function pickNextPublishSlot(channelId, publishHour) {
  const taken = jobs
    .filter(j => j.channelId === channelId && j.options.publishAt && !['failed', 'cancelled'].includes(j.status))
    .map(j => new Date(j.options.publishAt).getTime());
  let day = 1;
  while (true) {
    const slot = new Date();
    slot.setDate(slot.getDate() + day);
    slot.setHours(publishHour, 0, 0, 0);
    const clash = taken.some(t => Math.abs(t - slot.getTime()) < 6 * 3600 * 1000);
    if (!clash && slot.getTime() > Date.now() + 3600 * 1000) {
      return slot.toISOString();
    }
    day += 1;
  }
}

async function fullAutopilotTick() {
  if (autopilotPaused || autoScanBusy) return 0;
  autoScanBusy = true;
  let queuedCount = 0;
  try {
    const data = await deps.loadPlannerData();
    drainMode = data.settings?.autopilotDrain === true;
    if (drainMode) return 0;

    for (const channel of data.channels || []) {
      const cfg = channel.autopilot;
      if (!cfg || !cfg.enabled) {
        stoppedChannelIds.delete(channel.id);
        continue;
      }
      if (stoppedChannelIds.has(channel.id)) continue;
      const publishHour = Math.min(23, Math.max(0, parseInt(cfg.publishHour, 10) || 16));

      const hasPendingJob = jobs.some(j =>
        j.auto && j.channelId === channel.id && ['queued', 'running'].includes(j.status)
      );
      if (hasPendingJob) continue;

      // Best unproduced ideas, ranked by estimated ROI
      const queuedIdeaIds = new Set(jobs.filter(j => !['failed', 'cancelled'].includes(j.status)).map(j => j.plannerVideoId).filter(Boolean));
      const candidates = (data.videos || [])
        .filter(v => v.channelId === channel.id && ['idea', 'planned'].includes(v.status) && !queuedIdeaIds.has(v.id) && (v.topic || v.title))
        .sort((x, y) =>
          (ROI_RANK[y.roi && y.roi.potential] || 0) - (ROI_RANK[x.roi && x.roi.potential] || 0) ||
          (y.createdAt || 0) - (x.createdAt || 0)
        );
      if (candidates.length === 0) continue;

      const video = candidates[0];
      const publishAt = pickNextPublishSlot(channel.id, publishHour);
      const job = makeJob({
        channelId: channel.id,
        channelName: channel.name,
        plannerVideoId: video.id,
        title: video.title,
        topic: video.topic || video.title,
        brief: {
          angle: video.angle || '',
          hook: video.hook || '',
          keyPoints: (video.keyPoints || []).filter(Boolean),
          targetAudience: video.targetAudience || ''
        },
        options: { ...(cfg.options || {}), publishAt },
        pipeline: isMusicChannel(channel) ? 'music' : 'explainer',
        auto: true
      });
      jobs.push(job);
      queuedCount += 1;
      console.log(`[autopilot] Full Autopilot queued for ${channel.name}: ${video.title} (publish ${publishAt})`);
      saveQueue();
      if (deps.notify) {
        deps.notify({
          title: `🤖 Full Autopilot queued the next video for ${channel.name}`,
          message: `"${video.title}" → ${new Date(publishAt).toLocaleString()}`
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('Full Autopilot scan failed:', err.message);
  } finally {
    autoScanBusy = false;
  }
  return queuedCount;
}

export function registerAutopilot(app, options) {
  deps = options;
  loadQueue();
  saveQueue();
  setTimeout(() => {
    deps.loadPlannerData()
      .then(data => { drainMode = data.settings?.autopilotDrain === true; })
      .catch(err => console.warn('Autopilot drain state load failed:', err.message));
  }, 0);
  if (autopilotPaused) {
    console.log(`Autopilot paused by AUTOPILOT_PAUSED (${jobs.length} job(s) available for inspection).`);
  } else {
    setInterval(workerTick, 5000);
    setInterval(fullAutopilotTick, AUTO_SCAN_MS);
    setTimeout(fullAutopilotTick, 30000); // first scan shortly after startup
    console.log(`Autopilot queue ready (${jobs.length} job(s) on record).`);
  }

  app.get('/api/autopilot', (req, res) => {
    res.json({ busy, paused: autopilotPaused, draining: drainMode, jobs: [...jobs].sort((x, y) => y.createdAt - x.createdAt) });
  });

  app.post('/api/autopilot/drain', async (req, res) => {
    try {
      drainMode = req.body.enabled === true;
      const data = await deps.loadPlannerData();
      data.settings = { ...(data.settings || {}), autopilotDrain: drainMode };
      await deps.savePlannerData(data);
      const outstanding = jobs.filter(job => ['queued', 'running'].includes(job.status)).length;
      if (!drainMode && !autopilotPaused) setTimeout(() => fullAutopilotTick(), 0);
      res.json({ success: true, draining: drainMode, outstanding });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/autopilot/enqueue', async (req, res) => {
    try {
      const { channelId = null, plannerVideoId = null, title, topic, brief = null, options: jobOpts = {} } = req.body;
      const cleanTopic = (topic || title || '').trim();
      if (!cleanTopic) return res.status(400).json({ error: 'Missing topic/title for the video' });

      let channelName = '';
      let pipeline = 'explainer';
      if (channelId) {
        const data = await deps.loadPlannerData();
        const ch = data.channels.find(c => c.id === channelId);
        if (ch) {
          channelName = ch.name;
          if (isMusicChannel(ch)) pipeline = 'music';
        }
      }

      const job = makeJob({
        channelId, channelName, plannerVideoId,
        title, topic: cleanTopic, brief,
        options: jobOpts,
        pipeline
      });
      jobs.push(job);
      saveQueue();
      console.log(`Autopilot job queued (${job.pipeline}): "${job.topic}" (publish ${job.options.publishAt || 'manual'})`);
      res.json({ success: true, job });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/autopilot/cancel', (req, res) => {
    const job = jobs.find(j => j.id === req.body.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (['done', 'ready', 'failed', 'cancelled'].includes(job.status)) {
      return res.status(400).json({ error: 'Job already finished' });
    }
    job.status = 'cancelled';
    saveQueue();
    res.json({ success: true });
  });

  app.post('/api/autopilot/retry', (req, res) => {
    const job = jobs.find(j => j.id === req.body.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!['failed', 'cancelled'].includes(job.status)) {
      return res.status(400).json({ error: 'Only failed or cancelled jobs can be retried' });
    }
    job.status = 'queued';
    job.error = null;
    job.step = null;
    job.progress = { index: 0, total: pipelineSteps(job).length };
    const fromScratch = req.body.fromScratch === true;
    if (fromScratch) job.artifacts = {};
    job.log.push({ t: Date.now(), msg: fromScratch ? 'Restarting from scratch.' : 'Resuming from saved artifacts.' });
    saveQueue();
    res.json({ success: true });
  });

  // Manual trigger for the Full Autopilot scan (also used by the UI's "Scan now")
  app.post('/api/autopilot/auto-run', async (req, res) => {
    if (autopilotPaused) {
      return res.status(503).json({ error: 'Autopilot is paused for this server process' });
    }
    if (drainMode) {
      return res.status(409).json({ error: 'Autopilot is stopping after the outstanding queue finishes' });
    }
    if (req.body.channelId) stoppedChannelIds.delete(req.body.channelId);
    const queued = await fullAutopilotTick();
    res.json({ success: true, queued });
  });

  app.post('/api/autopilot/stop-channel', (req, res) => {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'Missing channelId' });
    stoppedChannelIds.add(channelId);
    let cancelled = 0;
    for (const job of jobs) {
      if (job.auto && job.channelId === channelId && ['queued', 'running'].includes(job.status)) {
        job.status = 'cancelled';
        job.error = null;
        log(job, 'Stopped because Full Autopilot was turned off for this channel.');
        cancelled += 1;
      }
    }
    if (cancelled) saveQueue();
    res.json({ success: true, cancelled });
  });

  app.post('/api/autopilot/record-fixed-upload', (req, res) => {
    const { id, videoId, url, privacy, captionUploaded, renderFilename } = req.body;
    const job = jobs.find(candidate => candidate.id === id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!videoId || !url || renderFilename !== job.artifacts.renderFilename) {
      return res.status(400).json({ error: 'Invalid replacement upload record' });
    }
    job.artifacts.fixedMasterYoutube = {
      videoId,
      url,
      privacy: privacy || 'private',
      captionUploaded: captionUploaded === true,
      uploadedAt: new Date().toISOString(),
      replacesVideoId: job.artifacts.youtube?.videoId || null,
      renderFilename
    };
    saveQueue();
    res.json({ success: true, fixedMasterYoutube: job.artifacts.fixedMasterYoutube });
  });

  app.post('/api/autopilot/remove', (req, res) => {
    const before = jobs.length;
    jobs = jobs.filter(j => j.id !== req.body.id || j.status === 'running');
    if (jobs.length === before) return res.status(400).json({ error: 'Job not found or still running' });
    saveQueue();
    res.json({ success: true });
  });
}
