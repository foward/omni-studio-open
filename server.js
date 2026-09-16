import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import multer from 'multer';
import sharp from 'sharp';
import { cloud, initCloud, mirrorMedia, ensureMedia, archiveToLibrary, saveDoc, loadDoc } from './cloud.js';
import { registerYouTubeRoutes, youtubeConfigured } from './youtube.js';
import { registerAutopilot } from './autopilot.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Detect available ffmpeg filters at startup (cached)
let ffmpegHasDrawtext = false;
let ffmpegHasAss = false;
let ffmpegHasGradients = false;
(async () => {
  try {
    const { stdout } = await execAsync('ffmpeg -filters 2>&1');
    ffmpegHasDrawtext = /\bdrawtext\b/.test(stdout);
    ffmpegHasAss = /\b(?:ass|subtitles)\b/.test(stdout);
    ffmpegHasGradients = /\bgradients\b/.test(stdout);
    console.log(`FFmpeg filter check: drawtext=${ffmpegHasDrawtext}, ass/subtitles=${ffmpegHasAss}`);
    if (!ffmpegHasDrawtext) {
      console.warn('FFmpeg drawtext unavailable; title cards will use rasterized text overlays.');
    }
  } catch (e) {
    console.warn('Could not detect ffmpeg filters:', e.message);
  }
})();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('Error: GEMINI_API_KEY is not set. Copy .env.example to .env and add your Gemini API key.');
  process.exit(1);
}
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.6-flash';
const GEMINI_IMAGE_MODELS = (process.env.GEMINI_IMAGE_MODELS || 'gemini-3.1-flash-image-preview,gemini-3-pro-image-preview')
  .split(',')
  .map(model => model.trim())
  .filter(Boolean);
const INTERACTIONS_URL = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${GEMINI_API_KEY}`;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Ensure output directories exist
const publicDir = path.join(__dirname, 'public');
const outputsDir = path.join(publicDir, 'outputs');
const presetsDir = path.join(publicDir, 'presets');

[publicDir, outputsDir, presetsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure Multer for audio uploads with security controls (file type filter + max file size limit)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, outputsDir);
  },
  filename: (req, file, cb) => {
    const rawExt = path.extname(file.originalname || '');
    const safeExt = rawExt.replace(/[^a-zA-Z0-9_.-]/g, '');
    cb(null, `audio_${Date.now()}${safeExt}`);
  }
});

const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/webm'
]);

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit to mitigate DoS risks
  fileFilter: (req, file, cb) => {
    if (file.mimetype && ALLOWED_AUDIO_MIME_TYPES.has(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only audio files are allowed.'));
    }
  }
});

// Cloud media pull-through: if a requested output isn't on this machine, fetch
// it from Cloud Storage first (lets a second Mac play media it never generated).
app.use('/outputs', async (req, res, next) => {
  if (!cloud.storageEnabled) return next();
  const name = sanitizeFilename(decodeURIComponent(req.path.replace(/^\//, '')));
  if (!name) return next();
  const local = path.join(outputsDir, name);
  if (!fs.existsSync(local)) {
    await ensureMedia(name, local).catch(() => {});
  }
  next();
});

// Mirror newly written output files up to Cloud Storage (skips temp artifacts).
// A size-stabilization check avoids uploading a file mid-write.
const TEMP_MEDIA_RE = /(_raw_|_src_|conformed_|merged_|_silent|concat_|inputs_|^export_|\.txt$|\.ass$|\.pcm$|\.aiff$)/;
// Guarantee a just-written asset reaches GCS. fs.watch silently drops events
// under burst load (e.g. generating 16 scenes back-to-back), which left some
// projects with metadata in Firestore but no video bytes in the bucket — so the
// other Mac showed blank scenes. Generators call this explicitly to be sure.
async function persistMirror(filename) {
  if (!cloud.storageEnabled || TEMP_MEDIA_RE.test(filename)) return;
  try {
    await mirrorMedia(path.join(outputsDir, filename));
  } catch (e) {
    console.warn(`Explicit mirror failed for ${filename}: ${e.message}`);
  }
}

const mirrorTimers = new Map();
function scheduleMirror(filename) {
  if (!cloud.storageEnabled || TEMP_MEDIA_RE.test(filename)) return;
  clearTimeout(mirrorTimers.get(filename));
  mirrorTimers.set(filename, setTimeout(async () => {
    mirrorTimers.delete(filename);
    const p = path.join(outputsDir, filename);
    try {
      let size = -1;
      for (let i = 0; i < 20; i++) {
        if (!fs.existsSync(p)) return;              // deleted (temp) before we uploaded
        const s = fs.statSync(p).size;
        if (s === size && s > 0) break;             // size stable → write finished
        size = s;
        await new Promise(r => setTimeout(r, 800));
      }
      await mirrorMedia(p);
    } catch { /* best-effort */ }
  }, 1500));
}
try {
  fs.watch(outputsDir, (_event, filename) => { if (filename) scheduleMirror(filename); });
} catch (e) {
  console.warn('Output dir watch unavailable (cloud mirror will rely on lazy pull):', e.message);
}

// Serve public directory
app.use(express.static(publicDir));

// Direct YouTube upload routes (OAuth 2.0). Trust proxy so redirect URIs use https on Cloud Run.
app.set('trust proxy', true);
registerYouTubeRoutes(app, { outputsDir, sanitizeFilename });

// Generic user alert: native macOS notification + optional email (SMTP_* env).
// Used by Autopilot for "video scheduled / assets ready / job failed" pings.
async function notifyUser({ title, message, html = null }) {
  if (process.platform === 'darwin') {
    try {
      const script = `display notification ${JSON.stringify(String(message))} with title ${JSON.stringify(String(title))}`;
      await execFileAsync('osascript', ['-e', script]);
    } catch { /* notification is best-effort */ }
  }
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, DIGEST_EMAIL_TO } = process.env;
  if (SMTP_HOST && DIGEST_EMAIL_TO) {
    try {
      const nodemailer = (await import('nodemailer')).default;
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT || '587', 10),
        secure: SMTP_PORT === '465',
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
      });
      await transporter.sendMail({
        from: SMTP_USER || 'omnistudio@localhost',
        to: DIGEST_EMAIL_TO,
        subject: title,
        html: html || `<p>${String(message)}</p>`
      });
    } catch (err) {
      console.warn('Notification email failed:', err.message);
    }
  }
}

// Autopilot job queue: hands-free idea → published video pipeline
registerAutopilot(app, {
  outputsDir,
  loadPlannerData: (...a) => loadPlannerData(...a),
  savePlannerData: (...a) => savePlannerData(...a),
  baseUrl: () => `http://127.0.0.1:${process.env.PORT || 3000}`,
  notify: notifyUser
});

// Endpoint for client-triggered native notifications (scenes ready, render errors, etc.)
app.post('/api/notify', async (req, res) => {
  try {
    const { title, message } = req.body;
    if (title && message) {
      await notifyUser({ title, message });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cloud status for the client (tells it whether to sync projects to Firestore)
app.get('/api/cloud/status', (req, res) => res.json(cloud.status));

// Cross-machine project library, stored in Firestore under one doc
app.get('/api/cloud/projects', async (req, res) => {
  if (!cloud.firestoreEnabled) return res.json({ enabled: false, index: null });
  const index = await loadDoc('projects', 'library');
  res.json({ enabled: true, index: index || null });
});

app.put('/api/cloud/projects', async (req, res) => {
  if (!cloud.firestoreEnabled) return res.json({ enabled: false, saved: false });
  const ok = await saveDoc('projects', 'library', req.body.index || {});
  res.json({ enabled: true, saved: ok });
});

// Backfill: upload the given filenames to GCS if they exist locally. Run on the
// Mac that HAS the videos to recover a project whose bytes never mirrored — the
// other Mac's /outputs pull-through can then fetch them. Reports per-file status.
app.post('/api/cloud/backfill', async (req, res) => {
  if (!cloud.storageEnabled) return res.status(400).json({ error: "Cloud Storage not configured" });
  const filenames = Array.isArray(req.body.filenames) ? req.body.filenames : [];
  const result = { uploaded: [], missingLocally: [], skipped: [] };
  for (const raw of filenames) {
    const name = sanitizeFilename(raw);
    if (!name) { result.skipped.push(raw); continue; }
    const p = path.join(outputsDir, name);
    if (!fs.existsSync(p)) { result.missingLocally.push(name); continue; }
    const ok = await mirrorMedia(p);
    if (ok) result.uploaded.push(name); else result.skipped.push(name);
  }
  console.log(`Backfill: ${result.uploaded.length} uploaded, ${result.missingLocally.length} missing locally, ${result.skipped.length} skipped`);
  res.json({ success: true, ...result });
});

// Pre-defined story prompts for child music video
const DEFAULT_PRESETS = {
  characters: [
    { id: 'panda', name: 'Luna the Panda', file: 'presets/preset_panda.png' },
    { id: 'penguin', name: 'Pip the Penguin', file: 'presets/preset_penguin.png' },
    { id: 'fox', name: 'Rusty the Fox', file: 'presets/preset_fox.png' },
    { id: 'leo', name: 'Leo the Lion', file: 'presets/preset_leo.jpg' },
    { id: 'monkey', name: 'Momo the Monkey', file: 'presets/preset_monkey.jpg' },
    { id: 'cow', name: 'Lola the Cow', file: 'presets/preset_cow.jpg' },
    { id: 'elephant', name: 'Elias the Elephant', file: 'presets/preset_elephant.png' },
    { id: 'giraffe', name: 'Georgie the Giraffe', file: 'presets/preset_giraffe.png' }
  ],
  scenePrompts: [
    "playing a small xylophone under a colorful rainbow, 3D claymation style, happy and cheerful mood",
    "dancing in a puddle with a bright yellow umbrella while colorful music notes float around, 3D claymation style",
    "sailing a tiny paper boat down a sparkling blue stream in a magical forest, 3D claymation style",
    "flying a small toy rocket ship through a starry, cartoon night sky, 3D claymation style, magical atmosphere"
  ]
};

// Format total seconds as MM:SS
function secToTime(totalSec) {
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Assign server-enforced 10s timestamps to a scene list (last scene gets the remainder)
function assignSceneTimestamps(scenes, durationSeconds) {
  const totalDuration = Math.round(durationSeconds);
  for (let i = 0; i < scenes.length; i++) {
    const startSec = i * 10;
    const endSec = (i === scenes.length - 1) ? totalDuration : Math.min((i + 1) * 10, totalDuration);
    scenes[i].start = secToTime(startSec);
    scenes[i].end = secToTime(endSec);
  }
  return scenes;
}

// Filename sanitization helper to prevent path traversal and shell injection
function sanitizeFilename(filename) {
  if (typeof filename !== 'string') return null;
  const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (safeName === '.' || safeName === '..') return null;
  return safeName;
}

// Get presets endpoint
app.get('/api/presets', (req, res) => {
  res.json(DEFAULT_PRESETS);
});

// Audio upload endpoint
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    const filePath = req.file.path;
    // Query file duration using ffprobe safely with argument array
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    const duration = parseFloat(stdout.trim());

    console.log(`Uploaded audio ${req.file.filename}, Duration: ${duration}s`);

    res.json({
      success: true,
      filename: req.file.filename,
      duration: duration
    });
  } catch (error) {
    console.error("Audio upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Enhance video prompt using DeepMind Gemini Omni Prompt Guide (5-Element Scene Anatomy)
app.post('/api/enhance-prompt', async (req, res) => {
  try {
    const { prompt, style = '3D claymation animation style', characterName = '', isContinuation = false, previousPrompt = '' } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Missing prompt to enhance" });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    let systemPrompt = `
You are an expert AI Video Prompt Engineer following the official Google DeepMind Gemini Omni Prompt Guide.
Expand and rewrite the user's short prompt into a high-fidelity video prompt adhering strictly to DeepMind's 5-Element Scene Anatomy:

1. SUBJECT: Vivid description of character or main subject (${characterName ? `featuring "${characterName}"` : 'subject details'}).
2. ACTION & MOTION PHYSICS: Specific motion of subject and environmental dynamics (e.g. splashing arc droplets, floating particles).
3. VISUAL STYLE & MEDIUM: Exact aesthetic medium (e.g. "${style}").
4. CAMERA MOTION: Explicit camera movement (e.g. slow tracking pan left, smooth orbital 360 spin, dynamic low-angle push-in, static close-up).
5. LIGHTING & ATMOSPHERE: Lighting setup and mood (e.g. soft golden-hour rim light, warm pastel volumetric atmosphere, glowing reflections).
`;

    if (isContinuation && previousPrompt) {
      systemPrompt += `
CRITICAL CONSTRAINT: This scene is a direct, seamless continuation of the previous scene.
The background location, set, environment, and lighting must be EXACTLY IDENTICAL to the previous scene, which is described as: "${previousPrompt}".
Do NOT introduce any new or different backgrounds, environments, locations, or lighting settings.
Keep the background elements stable and unchanged, and focus the enhancement entirely on the subject's action, movement, camera motion, and visual medium consistency.
`;
    }

    systemPrompt += `
Rule: Output ONLY the enhanced single prompt string (max ~50 words). Include a natural language negative constraint: "clean visual frame, no text or graphic overlays".
`;

    const requestBody = {
      contents: [{
        parts: [
          { text: systemPrompt },
          { text: `User prompt to enhance: "${prompt}"` }
        ]
      }]
    };

    console.log(`Enhancing prompt via DeepMind Omni Guide: "${prompt.slice(0, 40)}..."`);

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Gemini prompt enhancement failed: ${errorText}`);
    }

    const data = await apiResponse.json();
    const enhancedPrompt = data.candidates[0].content.parts[0].text.trim();

    res.json({ success: true, originalPrompt: prompt, enhancedPrompt: enhancedPrompt });
  } catch (error) {
    console.error("Enhance prompt error:", error);
    res.status(500).json({ error: error.message });
  }
});

// AI script generation endpoint using the configured Gemini text model
app.post('/api/generate-script', async (req, res) => {

  try {
    const { lyrics, audioFilename, characterName, durationSeconds } = req.body;

    if (!characterName || !durationSeconds) {
      return res.status(400).json({ error: "Missing characterName or durationSeconds" });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    // Calculate scene count: all scenes are 10s, last scene gets remainder.
    // E.g. 152s → 16 scenes (15 × 10s + 1 × 2s)
    const numScenes = Math.ceil(durationSeconds / 10);
    
    let promptParts = [];

    // Multimodal audio path (if lyrics are not provided)
    if (!lyrics && audioFilename) {
      const safeAudioFilename = sanitizeFilename(audioFilename);
      if (!safeAudioFilename) {
        return res.status(400).json({ error: "Invalid audio filename" });
      }

      const audioPath = path.join(outputsDir, safeAudioFilename);
      if (!fs.existsSync(audioPath)) {
        return res.status(400).json({ error: "Audio file not found" });
      }

      console.log(`Reading audio for multimodal transcription from ${audioPath}`);
      const audioBuffer = await fs.promises.readFile(audioPath);
      const audioBase64 = audioBuffer.toString('base64');
      const ext = path.extname(safeAudioFilename).toLowerCase();
      const mimeType = ext === '.wav' ? 'audio/wav' : 'audio/mp3';

      promptParts.push({
        inlineData: {
          mimeType: mimeType,
          data: audioBase64
        }
      });

      const systemPrompt = `
    You are an expert children's music video director and retention editor.
Listen to the attached audio file.
1. Transcribe the lyrics of the song in the "transcribedLyrics" field.
2. Create exactly ${numScenes} UNIQUE scene descriptions (prompts) for the character "${characterName}".
   - Each scene prompt must be different and describe a distinct action or moment.
   - Do NOT repeat or duplicate any prompt text across scenes.
3. To maintain visual coherence, indicate whether each scene shares the same setting/background as the previous scene (using the "newBackground" boolean field).
   - For Scene 1, "newBackground" is always true.
   - If a scene changes setting, "newBackground" is true.
   - If it continues in the same setting, "newBackground" is false.
4. Each prompt MUST describe the action of "${characterName}" in "3D claymation style" matching the song's narrative. Keep it descriptive for a video generator.
5. Engineer visual retention: Scene 1 must open on the song's most instantly understandable action or surprise; every later scene must introduce visible progression through a new action, prop, camera move, scale, or emotional beat. Never rely on a static character singing to camera.
6. Keep the story simple, clear, and relatable for a fast-scrolling family audience. Build toward a satisfying final payoff or repeatable dance/action that rewards watching to the end.
7. You do NOT need to worry about timestamps - the server will compute them automatically.
   Just set start and end to "00:00" for every scene.

Generate the output conforming to the response schema.
`;
      promptParts.push({ text: systemPrompt });

    } else {
      // Text-only script generation path
      const systemPrompt = `
You are an expert children's music video director and retention editor.
Create exactly ${numScenes} UNIQUE scene descriptions (prompts) for the character "${characterName}".
The song lyrics are:
"${lyrics || ''}"
The total duration of the song is ${durationSeconds} seconds.

Rules:
1. Each scene prompt must be different and describe a distinct action or moment matching the lyrics.
   Do NOT repeat or duplicate any prompt text across scenes.
2. To maintain visual coherence, indicate whether each scene shares the same setting/background as the previous scene (using the "newBackground" boolean field).
   - For Scene 1, "newBackground" is always true.
   - If a scene changes setting, "newBackground" is true.
   - If it continues in the same setting, "newBackground" is false.
3. Each prompt MUST describe the action of "${characterName}" in "3D claymation style" matching the song's narrative. Keep it descriptive for a video generator.
4. Populate the "transcribedLyrics" field with the original lyrics.
5. Engineer visual retention: Scene 1 must open on the song's most instantly understandable action or surprise; every later scene must introduce visible progression through a new action, prop, camera move, scale, or emotional beat. Never rely on a static character singing to camera.
6. Keep the story simple, clear, and relatable for a fast-scrolling family audience. Build toward a satisfying final payoff or repeatable dance/action that rewards watching to the end.
7. You do NOT need to worry about timestamps - the server will compute them automatically.
   Just set start and end to "00:00" for every scene.

Generate the output conforming to the response schema.
`;
      promptParts.push({ text: systemPrompt });
    }

    const requestBody = {
      contents: [{
        parts: promptParts
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            transcribedLyrics: { type: "STRING" },
            scenes: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  start: { type: "STRING" },
                  end: { type: "STRING" },
                  prompt: { type: "STRING" },
                  newBackground: { type: "BOOLEAN" }
                },
                required: ["start", "end", "prompt", "newBackground"]
              }
            }
          },
          required: ["scenes", "transcribedLyrics"]
        }
      }
    };

    console.log(`Generating AI script for "${characterName}" with song length ${durationSeconds}s (${numScenes} scenes)`);

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Gemini API script gen failed: ${errorText}`);
    }

    const data = await apiResponse.json();
    const responseText = data.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(responseText);

    // -----------------------------------------------------------------
    // SERVER-SIDE TIMESTAMP COMPUTATION
    // We completely ignore whatever timestamps Gemini returned.
    // All scenes get exactly 10 seconds, except the last scene
    // which gets the remainder to fill the total song duration.
    // This guarantees no scene ever exceeds 10s.
    // -----------------------------------------------------------------
    const scenes = assignSceneTimestamps(parsed.scenes || [], durationSeconds);

    const durations = scenes.map(s => {
      const [sm, ss] = s.start.split(':').map(Number);
      const [em, es] = s.end.split(':').map(Number);
      return (em * 60 + es) - (sm * 60 + ss);
    });
    console.log(`Scene durations (server-enforced): [${durations.join(', ')}]`);

    res.json({ ...parsed, scenes });
  } catch (error) {
    console.error("Script generation error:", error);
    res.status(500).json({ error: error.message });
  }
});


// Generic "prompt → video" plan generation using the configured Gemini text model
app.post('/api/generate-explainer-script', async (req, res) => {
  try {
    const { topic, durationSeconds = 60, style = 'modern 3D animated explainer style, colorful, clean infographic aesthetics', brief = null } = req.body;

    if (!topic || !topic.trim()) {
      return res.status(400).json({ error: "Missing topic prompt" });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const numScenes = Math.ceil(durationSeconds / 10);

    // Optional content brief carried from a trend-radar suggestion — keeps the
    // generated video on the specific viral angle instead of re-deriving generically
    let briefBlock = '';
    if (brief && (brief.angle || (brief.keyPoints && brief.keyPoints.length) || brief.hook)) {
      const kp = (brief.keyPoints || []).filter(Boolean);
      briefBlock = `
This video comes from a researched content idea. Honor this brief so it keeps its viral angle:
${brief.angle ? `- Unique angle: ${brief.angle}` : ''}
${brief.hook ? `- Opening hook (Scene 1 should deliver this): ${brief.hook}` : ''}
${brief.targetAudience ? `- Target audience: ${brief.targetAudience}` : ''}
${kp.length ? `- Key points the video MUST cover, in order:\n${kp.map((p, i) => `   ${i + 1}. ${p}`).join('\n')}` : ''}
Distribute the key points across the scenes so every one is covered by the narration.
`;
    }

    const ctaPhrase = `Thank you for watching! If you would like to watch more of these short videos, please subscribe and comment below what do you think about ${topic}.`;

    const systemPrompt = `
You are an expert YouTube video director, retention editor, and storyteller.
The user wants a video about: "${topic}"
${briefBlock}
Create exactly ${numScenes} scenes for a ${durationSeconds}-second video.

Retention architecture:
- Build one uninterrupted train of thought: Hook/Problem → escalating Value/Solution → Payoff/CTA bridge.
- Scene 1 must deliver a scroll-stopping spoken hook immediately. No greeting, channel intro, throat-clearing, or generic setup. Open with tension, contrast, mystery, urgency, or an unexpected visual claim.
- Use everyday language. Every narration line must be simple, clear, relatable, and useful.
- Every scene must visibly progress the story with a demonstration, transformation, comparison, animated evidence, or changing action. Avoid consecutive talking-head or static infographic scenes.
- Add a meaningful pattern interrupt every 2-3 scenes through camera scale, setting, motion, reveal, or emotional contrast while preserving visual continuity.
- The final scene must resolve the opening promise and naturally bridge to a related next question or viewer action; do not use a generic sign-off.

Rules for each scene:
1. "prompt": a rich, self-contained visual description for an AI video generator.
   Describe ONE clear visual moment in "${style}".
   Every prompt must be unique — do NOT repeat or duplicate prompt text across scenes.
   Do NOT ask for any on-screen text, captions, or words inside the video itself.
   For the LAST scene (Scene ${numScenes}), the prompt should describe an engaging closing visual (e.g. presenter or character engaging the audience at the end of the video).
2. "narration": one short spoken subtitle sentence for that scene.
   The narrations must flow together so the full sequence reads as one coherent script that actually teaches/explains the topic from start to finish.
   IMPORTANT: The LAST scene (Scene ${numScenes}) MUST include or end with this exact call-to-action narration: "${ctaPhrase}"
3. "newBackground": true if the scene changes setting versus the previous scene,
   false if it continues in the same setting. Scene 1 is always true.

Also produce "videoTitle": a high-CTR YouTube title under 60 characters with one core idea, a clear viewer reward, ruthless brevity, and an honest curiosity gap. Prefer result over process and front-load the natural search phrase.
Also produce "musicPrompt": a one-sentence instrumental background music description for a music
generation model, matching the topic's narrative mood (e.g. "calm ambient documentary underscore,
soft piano and warm strings, slow tempo, reflective, no vocals"). Always instrumental, never vocals.
Set start and end to "00:00" for every scene — the server computes timestamps.

Generate the output conforming to the response schema.
`;

    const requestBody = {
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            videoTitle: { type: "STRING" },
            musicPrompt: { type: "STRING" },
            scenes: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  start: { type: "STRING" },
                  end: { type: "STRING" },
                  prompt: { type: "STRING" },
                  narration: { type: "STRING" },
                  newBackground: { type: "BOOLEAN" }
                },
                required: ["start", "end", "prompt", "narration", "newBackground"]
              }
            }
          },
          required: ["videoTitle", "musicPrompt", "scenes"]
        }
      }
    };

    console.log(`Generating explainer plan for "${topic}" (${durationSeconds}s, ${numScenes} scenes)`);

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Gemini API explainer plan failed: ${errorText}`);
    }

    const data = await apiResponse.json();
    const parsed = JSON.parse(data.candidates[0].content.parts[0].text);
    const scenes = assignSceneTimestamps(parsed.scenes || [], durationSeconds);

    if (scenes.length > 0) {
      const lastScene = scenes[scenes.length - 1];
      if (!lastScene.narration || !lastScene.narration.toLowerCase().includes("thank you for watching")) {
        lastScene.narration = lastScene.narration
          ? `${lastScene.narration.trim()} ${ctaPhrase}`
          : ctaPhrase;
      }
    }

    res.json({ videoTitle: parsed.videoTitle, musicPrompt: parsed.musicPrompt, scenes });
  } catch (error) {
    console.error("Explainer plan generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// YouTube SEO & monetization kit generation using the configured Gemini text model
app.post('/api/generate-seo', async (req, res) => {
  try {
    const { topic, lyrics, durationSeconds, sceneCount = 6, videoType = 'explainer', scenePrompts = [], language = '' } = req.body;

    if (!topic && !lyrics) {
      return res.status(400).json({ error: "Provide a topic or lyrics to generate SEO metadata" });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const langInstruction = language ? `\nIMPORTANT: Write ALL output (titles, description, tags, hashtags, chapters, thumbnail text, tips) in ${language}, tailored for a ${language}-speaking YouTube audience — translate/adapt keywords naturally, don't transliterate.` : '';

    const contextBlock = topic
      ? `The video is about: "${topic}"`
      : `The video is a ${videoType} music video with these lyrics:\n"${lyrics}"`;
    const scenesBlock = scenePrompts.length > 0
      ? `The video contains these scenes in order:\n${scenePrompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      : '';

    const systemPrompt = `
You are a YouTube growth strategist and packaging editor helping a creator earn the click, hold attention, and chain the next view.
${contextBlock}
${scenesBlock}
Video length: ~${Math.round(durationSeconds || 60)} seconds, ${sceneCount} scenes.${langInstruction}

Produce a complete YouTube upload kit optimized for search, click-through rate, retention, and session watch time:
1. "titles": 5 alternative titles. Each must express ONE core idea, stay under 60 characters,
   front-load the natural search phrase, promise a result or reveal, and remove every expendable word.
   Use distinct honest angle twists (contrast, mystery, unexpected change, personal tension, or urgency).
   Do not stuff concepts, use generic hype, or make claims the video does not deliver.
2. "description": a ready-to-paste YouTube description. The first 150 characters must
   contain the main keyword and work as a standalone hook (that's what shows in search).
  Include a short paragraph and a concise "What you'll learn/hear" bullet list. End with a contextual
  CTA that points to the most relevant next video or playlist topic, then exactly 3 hashtags.
  Mention the video is AI-assisted where relevant for transparency.
3. "tags": 15-20 tags, most-specific first, total under 480 characters combined.
4. "hashtags": exactly 3 hashtags (YouTube shows only the first 3 above the title).
5. "chapterTitles": exactly ${sceneCount} short chapter names matching the scenes in order
   (chapters boost watch-time navigation and can surface in Google search).
6. "thumbnailIdeas": 3 concrete thumbnail concepts. Each must have one dominant focal subject,
   a readable emotional contrast or visual mystery in one second, and a clean silhouette at phone size.
   The image must add a NEW layer of tension to the title rather than repeat or illustrate its words.
   Specify composition, focal emotion/object, title-thumbnail contrast, and optional text under 4 words.
7. "postingTips": 5 specific, actionable strategy tips for growing and monetizing THIS kind of
  AI-generated content on YouTube (one exceptional long-form anchor, hook-led Shorts cut-downs,
  cross-posting, playlists, a specific next-video end-screen bridge,
   YPP requirements, avoiding "reused content" demonetization by adding original narration/editing value).
  8. "openingHook": the exact first spoken line for the opening 1-2 seconds. No greeting or setup;
     create immediate tension and deliver the title's promise visually.
  9. "pinnedComment": one natural question that invites viewers to share an opinion, experience,
     prediction, or choice specific to this video. Never ask only for generic likes or subscriptions.
  10. "endScreenBridge": one short spoken sentence that resolves this video's promise and creates
    curiosity for the most relevant next video topic. It must sound like a continuation, not a sign-off.
  11. "shortsHooks": exactly 3 distinct first-line hooks for short-form cut-downs, each focused on
    one surprising visual beat from this video and understandable without prior context.
  12. "introCardTitle": a bold, curiosity-led opening card title under 7 words. It must express
    this video's specific promise, not a production label, tool name, or generic video category.
  13. "introCardSubtitle": a complementary line under 10 words that adds context or tension without
    repeating the title. Never mention Gemini, AI production, Lyria, or "music video".
  14. "introBackgroundPrompt": the visual direction for a finished YouTube opening card: one dominant
    expressive face or equally powerful surprise reveal, strong contrast, brand-consistent style, and a
    composition that supports huge phone-readable title typography. Do not prescribe additional copy.
  15. "outroCardTitle": a contextual next-view curiosity line under 7 words. It must continue this
    video's subject or reveal, never say thanks, stream, subscribe, follow, or name a platform.
  16. "outroCardCTA": a specific action line under 12 words that tells the viewer what related story,
    reveal, or video to watch next. It must be unique to this video's context, not a generic subscription CTA.
  17. "outroBackgroundPrompt": the visual direction for a finished full-frame YouTube closing card that
    continues the final visual and introduces one intriguing reveal pointing toward the next related story.
    Preserve the channel brand and support huge phone-readable CTA typography. Fill the frame naturally;
    never request reserved space, video previews, interface boxes, buttons, lower thirds, or overlay placements.
    Do not prescribe additional copy.

Generate the output conforming to the response schema.
`;

    const requestBody = {
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            titles: { type: "ARRAY", items: { type: "STRING" } },
            description: { type: "STRING" },
            tags: { type: "ARRAY", items: { type: "STRING" } },
            hashtags: { type: "ARRAY", items: { type: "STRING" } },
            chapterTitles: { type: "ARRAY", items: { type: "STRING" } },
            thumbnailIdeas: { type: "ARRAY", items: { type: "STRING" } },
            postingTips: { type: "ARRAY", items: { type: "STRING" } },
            openingHook: { type: "STRING" },
            pinnedComment: { type: "STRING" },
            endScreenBridge: { type: "STRING" },
            shortsHooks: { type: "ARRAY", items: { type: "STRING" } },
            introCardTitle: { type: "STRING" },
            introCardSubtitle: { type: "STRING" },
            introBackgroundPrompt: { type: "STRING" },
            outroCardTitle: { type: "STRING" },
            outroCardCTA: { type: "STRING" },
            outroBackgroundPrompt: { type: "STRING" }
          },
          required: ["titles", "description", "tags", "hashtags", "chapterTitles", "thumbnailIdeas", "postingTips", "openingHook", "pinnedComment", "endScreenBridge", "shortsHooks", "introCardTitle", "introCardSubtitle", "introBackgroundPrompt", "outroCardTitle", "outroCardCTA", "outroBackgroundPrompt"]
        }
      }
    };

    console.log(`Generating YouTube SEO kit (${topic ? `topic: ${topic}` : 'music video'})`);

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Gemini API SEO gen failed: ${errorText}`);
    }

    const data = await apiResponse.json();
    const parsed = JSON.parse(data.candidates[0].content.parts[0].text);

    res.json(parsed);
  } catch (error) {
    console.error("SEO kit generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Generate 360-degree character turnaround and extract keyframe angles
app.post('/api/generate-turnaround', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "Missing imageBase64" });
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const cleanMimeType = mimeType || 'image/png';

    console.log("Generating 360-degree turnaround rotation for character...");

    const requestBody = {
      model: "gemini-omni-flash-preview",
      input: [
        {
          type: "image",
          data: cleanBase64,
          mime_type: cleanMimeType
        },
        {
          type: "text",
          text: "A slow 360-degree turnaround rotation of this character, showing it from front, side, and back views, 3D claymation style, static solid white background."
        }
      ],
      response_format: {
        type: "video",
        aspect_ratio: "16:9"
      }
    };

    const apiResponse = await fetch(INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Revision': '2026-05-20'
      },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error("Gemini API Turnaround Error Response:", errorText);
      throw new Error(`Gemini API returned status ${apiResponse.status}: ${errorText}`);
    }

    const data = await apiResponse.json();

    let videoBase64 = null;
    if (data.steps && Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (step.type === 'model_output' && step.content) {
          const videoContent = step.content.find(item => item.type === 'video');
          if (videoContent && videoContent.data) {
            videoBase64 = videoContent.data;
            break;
          }
        }
      }
    }

    if (!videoBase64) {
      throw new Error("No video content returned for turnaround rotation");
    }

    const videoBuffer = Buffer.from(videoBase64, 'base64');
    const tempVideoPath = path.join(outputsDir, `turnaround_${Date.now()}.mp4`);
    await fs.promises.writeFile(tempVideoPath, videoBuffer);

    // Extract Front (0.5s), Side (3.0s), and Back (6.0s) frames
    const frame0Path = path.join(outputsDir, `frame_front_${Date.now()}.png`);
    const frame1Path = path.join(outputsDir, `frame_side_${Date.now()}.png`);
    const frame2Path = path.join(outputsDir, `frame_back_${Date.now()}.png`);

    console.log("Extracting character view keyframes using FFmpeg...");
    await execAsync(`ffmpeg -y -ss 0.5 -i "${tempVideoPath}" -vframes 1 -q:v 2 "${frame0Path}"`);
    await execAsync(`ffmpeg -y -ss 3.0 -i "${tempVideoPath}" -vframes 1 -q:v 2 "${frame1Path}"`);
    await execAsync(`ffmpeg -y -ss 6.0 -i "${tempVideoPath}" -vframes 1 -q:v 2 "${frame2Path}"`);

    const toBase64 = (filePath) => {
      const fileBuffer = fs.readFileSync(filePath);
      return `data:image/png;base64,${fileBuffer.toString('base64')}`;
    };

    const views = [
      toBase64(frame0Path),
      toBase64(frame1Path),
      toBase64(frame2Path)
    ];

    // Cleanup temp files
    fs.unlink(tempVideoPath, () => {});
    fs.unlink(frame0Path, () => {});
    fs.unlink(frame1Path, () => {});
    fs.unlink(frame2Path, () => {});

    console.log("Turnaround character views extracted successfully!");

    res.json({
      success: true,
      views: views
    });

  } catch (error) {
    console.error("Turnaround generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Generate scene endpoint
// Extract the final frame of a generated scene as base64 PNG (background continuity seed)
async function lastFrameBase64(filename, tempFiles) {
  const safe = sanitizeFilename(filename);
  if (!safe) return null;
  const src = path.join(outputsDir, safe);
  if (!fs.existsSync(src)) return null;
  const framePath = path.join(outputsDir, `lastframe_${Date.now()}.png`);
  tempFiles.push(framePath);
  await execAsync(`ffmpeg -y -sseof -0.2 -i "${src}" -frames:v 1 -update 1 "${framePath}"`);
  return (await fs.promises.readFile(framePath)).toString('base64');
}

app.post('/api/generate-scene', async (req, res) => {
  const tempFrames = [];
  try {
    const { imageBase64, images, mimeType, characterName, sceneDescription, sceneIndex, previousInteractionId, previousSceneFilename, aspectRatio } = req.body;

    const safeAspect = aspectRatio === '9:16' ? '9:16' : '16:9';

    if (!sceneDescription) {
      return res.status(400).json({ error: "Missing sceneDescription" });
    }

    const hasCharRefs = !!((images && Array.isArray(images) && images.length > 0) || imageBase64);

    // Background continuity seed: the previous scene's final frame. Used for the fresh
    // path AND as the fallback when chaining fails — so continuity survives retries.
    let lastFrameB64 = null;
    if (previousSceneFilename) {
      try {
        lastFrameB64 = await lastFrameBase64(previousSceneFilename, tempFrames);
        if (lastFrameB64) console.log(`Scene ${sceneIndex + 1}: seeding background from the previous scene's final frame`);
      } catch (err) {
        console.warn(`Last-frame extraction failed (${err.message}) — continuing without the seed`);
      }
    }

    // Build the prompt with explicit continuity + anti-white-flash instructions.
    // The plain-background reference images define IDENTITY only — Omni must never
    // open the video showing that backdrop.
    const buildPromptText = (isChained, useLastFrame) => {
      let p = characterName ? `A video of the humanoid character ${characterName} ${sceneDescription}` : sceneDescription;
      if (isChained) {
        p = `Continue seamlessly from the previous video: keep the exact same location, background, lighting and color palette, with no scene cut. ${p}`;
      } else if (useLastFrame) {
        p = `The FIRST reference image is the exact final frame of the previous scene. Continue in that same location, background and lighting.${hasCharRefs ? " The remaining reference images define the character's appearance and project style." : ''} ${p}`;
      }
      if (characterName) {
        p += ` Important anatomy: ${characterName} is a humanoid cartoon character standing and walking upright on exactly two legs. They have exactly two arms and two legs, and never walk or stand on all fours.`;
      }
      if (hasCharRefs) {
        p += ` Start already inside the described environment from the very first frame — never show the character standing on the plain white reference-image background.`;
      }
      return p;
    };

    const buildFreshBody = () => {
      const inputParts = [];
      const useLastFrame = !!lastFrameB64;
      if (useLastFrame) {
        inputParts.push({ type: "image", data: lastFrameB64, mime_type: "image/png" });
      }
      if (images && Array.isArray(images) && images.length > 0) {
        images.forEach(imgData => {
          const cleanBase64 = imgData.replace(/^data:image\/\w+;base64,/, '');
          inputParts.push({ type: "image", data: cleanBase64, mime_type: "image/png" });
        });
      } else if (imageBase64) {
        const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        inputParts.push({ type: "image", data: cleanBase64, mime_type: mimeType || 'image/png' });
      }
      inputParts.push({ type: "text", text: buildPromptText(false, useLastFrame) });
      return {
        model: "gemini-omni-flash-preview",
        input: inputParts,
        response_format: { type: "video", aspect_ratio: safeAspect }
      };
    };

    let requestBody;
    if (previousInteractionId) {
      console.log(`Chaining scene ${sceneIndex + 1} from previous interaction: ${previousInteractionId}`);
      const inputParts = [];
      if (images && Array.isArray(images) && images.length > 0) {
        images.forEach(imgData => {
          const cleanBase64 = imgData.replace(/^data:image\/\w+;base64,/, '');
          inputParts.push({ type: "image", data: cleanBase64, mime_type: "image/png" });
        });
      } else if (imageBase64) {
        const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        inputParts.push({ type: "image", data: cleanBase64, mime_type: mimeType || 'image/png' });
      }
      inputParts.push({ type: "text", text: buildPromptText(true, false) });

      requestBody = {
        model: "gemini-omni-flash-preview",
        previous_interaction_id: previousInteractionId,
        input: inputParts,
        response_format: { type: "video", aspect_ratio: safeAspect }
      };
    } else {
      requestBody = buildFreshBody();
    }

    console.log(`Generating scene ${sceneIndex + 1}: "${sceneDescription}"${previousInteractionId ? ' (chained)' : (lastFrameB64 ? ' (frame-seeded)' : '')}`);

    // -------------------------------------------------------------------
    // Automatic retry with fallback.
    // Attempt 1: use chaining (previousInteractionId) if available.
    // If that fails (400/500), Attempt 2: fall back to a fresh call with
    // reference images instead of chaining.
    // -------------------------------------------------------------------
    const MAX_ATTEMPTS = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let currentRequestBody;

      if (attempt === 1) {
        // First attempt: use whatever was originally built (chained or fresh)
        currentRequestBody = requestBody;
      } else {
        // Fallback: fresh call that STILL carries continuity via the previous
        // scene's final frame (when available) + character references
        console.log(`Retry attempt ${attempt}: falling back to fresh (frame-seeded) call for scene ${sceneIndex + 1}`);
        currentRequestBody = buildFreshBody();
      }

      try {
        const apiResponse = await fetch(INTERACTIONS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Api-Revision': '2026-05-20'
          },
          body: JSON.stringify(currentRequestBody)
        });

        if (!apiResponse.ok) {
          const errorText = await apiResponse.text();
          console.error(`Gemini API Error (attempt ${attempt}):`, errorText);
          lastError = new Error(`Gemini API returned status ${apiResponse.status}: ${errorText}`);

          // If this is the first attempt and it's a recoverable error, retry
          if (attempt < MAX_ATTEMPTS && (apiResponse.status === 400 || apiResponse.status === 500)) {
            console.log(`Scene ${sceneIndex + 1} attempt ${attempt} failed (${apiResponse.status}), will retry as fresh call...`);
            continue;
          }
          throw lastError;
        }

        const data = await apiResponse.json();

        // Extract video from steps
        let videoBase64 = null;
        if (data.steps && Array.isArray(data.steps)) {
          for (const step of data.steps) {
            if (step.type === 'model_output' && step.content) {
              const videoContent = step.content.find(item => item.type === 'video');
              if (videoContent && videoContent.data) {
                videoBase64 = videoContent.data;
                break;
              }
            }
          }
        }

        if (!videoBase64) {
          console.error("Full API response without video content:", JSON.stringify(data).substring(0, 1000));
          lastError = new Error("No video content returned from Gemini API");
          if (attempt < MAX_ATTEMPTS) {
            console.log(`Scene ${sceneIndex + 1} no video content on attempt ${attempt}, retrying...`);
            continue;
          }
          throw lastError;
        }

        // Extract interactionId to return to frontend for chaining
        const interactionId = data.id || (data.name ? data.name.split('/').pop() : null);

        // Decode and save video
        const videoBuffer = Buffer.from(videoBase64, 'base64');
        const filename = `scene_${Date.now()}_${sceneIndex}.mp4`;
        const filepath = path.join(outputsDir, filename);

        await fs.promises.writeFile(filepath, videoBuffer);
        console.log(`Saved scene ${sceneIndex + 1} to ${filepath}${attempt > 1 ? ' (fallback fresh call)' : ''}`);
        await persistMirror(filename); // upload now so the other Mac can pull it

        return res.json({
          success: true,
          videoUrl: `/outputs/${filename}`,
          filename: filename,
          interactionId: interactionId
        });

      } catch (innerError) {
        lastError = innerError;
        if (attempt < MAX_ATTEMPTS) {
          continue;
        }
      }
    }

    // If all attempts exhausted
    throw lastError || new Error("All generation attempts failed");

  } catch (error) {
    console.error("Error generating scene:", error);
    res.status(500).json({ error: error.message });
  } finally {
    tempFrames.forEach(f => fs.unlink(f, () => {}));
  }
});

// AI thumbnail generation from a SEO-kit concept (Gemini image model)
async function reviewGeneratedCard(imageBase64, { cardTitle, cardSubtitle, channelName, cardRole }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const allowed = [cardTitle, cardSubtitle, channelName].filter(Boolean);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inlineData: { mimeType: 'image/png', data: imageBase64 } },
        { text: `Audit this finished YouTube ${cardRole || 'title'} card strictly.
Allowed text only: ${JSON.stringify(allowed)}
Required main title exactly: ${JSON.stringify(cardTitle)}
Required supporting line exactly: ${JSON.stringify(cardSubtitle)}
${channelName ? `Required small channel signature exactly: ${JSON.stringify(channelName)}` : 'No channel signature required.'}

Approve only when all are true:
1. Required text is spelled exactly and easily readable on a phone; main title is the largest text.
2. There are no extra readable labels, fragments, pseudo-words, watermarks, or UI text.
3. One dominant expressive face communicates surprise/awe/urgency/delight/discovery, or an equally strong reveal/visual mystery is clearly dominant.
4. The composition has one core idea, strong contrast, no clutter, and looks like premium YouTube packaging.
5. Every letter is fully visible with at least 8% safe margin from every image edge.
6. There are no fake video placeholders, black preview rectangles, interface boxes, buttons, or platform chrome.
Return concrete regeneration instructions for every failure.` }
      ] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            approved: { type: 'BOOLEAN' },
            score: { type: 'NUMBER' },
            exactCopy: { type: 'BOOLEAN' },
            safeMargins: { type: 'BOOLEAN' },
            noExtraTextOrUi: { type: 'BOOLEAN' },
            strongPackaging: { type: 'BOOLEAN' },
            issues: { type: 'ARRAY', items: { type: 'STRING' } },
            retryInstruction: { type: 'STRING' }
          },
          required: ['approved', 'score', 'exactCopy', 'safeMargins', 'noExtraTextOrUi', 'strongPackaging', 'issues', 'retryInstruction']
        }
      }
    })
  });
  if (!response.ok) throw new Error(`card review status ${response.status}`);
  const data = await response.json();
  return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
}

app.post('/api/generate-thumbnail', async (req, res) => {
  const tempFiles = [];
  try {
        const { concept, videoTitle, orientation = 'landscape', kind = 'thumbnail', referenceImages = [],
          songName = '', albumName = '', channelName = '', channelNiche = '', cardRole = '',
          cardTitle = '', cardSubtitle = '', seoTitle = '' } = req.body;

    if (!concept || !concept.trim()) {
      return res.status(400).json({ error: "Missing thumbnail concept" });
    }

    const isVertical = orientation === 'vertical';

    // Brand consistency: reference images (album cover, character sheets) condition
    // the generation so the SAME characters and art style appear in the output.
    const refs = (Array.isArray(referenceImages) ? referenceImages : [])
      .filter(r => typeof r === 'string' && r.length > 100)
      .slice(0, 4);
    const refBlock = refs.length ? `
STYLE & CHARACTER REFERENCES: the attached image(s) show this project's album cover / official
characters. Match their EXACT art style, rendering technique and color palette. The same
characters (same species, faces, outfits, proportions) must appear in your image. Create a NEW
composition for the concept below — do not copy a reference composition literally. References are
STYLE-ONLY: ignore and never reproduce any text, labels, captions, logos, or pseudo-words visible in them.` : '';

    let prompt;
    if (kind === 'album-cover') {
      prompt = `${refBlock}
Design a professional, high-impact ${isVertical ? 'vertical 9:16' : 'widescreen 16:9'} YouTube music video thumbnail and official album cover graphic.
Concept: ${concept}
The design must natively render and bake the following text overlay elements directly into the image:
1. Main Title (Song Name): "${songName || videoTitle || ''}" (render this in large, bold, highly legible, stylized 3D typography/font).
2. Subtitle (Album / Artist Name): "${albumName || ''}" (render this clearly styled below the main title).
${channelName ? `3. Channel Title: "${channelName}" (render this in a clean, secondary font).` : ''}
Requirements: Eye-catching layout with expressive characters, vibrant colors, cinematic contrast, well-integrated graphics, and perfect text alignment.`;

    } else if (kind === 'card-bg' || kind === 'intro-card' || kind === 'outro-card') {
      const isOutro = kind === 'outro-card' || /outro|cta|subscribe/i.test(concept);
      const displayTitle = videoTitle || songName || concept;
      prompt = `${refBlock}
Design the COMPLETE finished ${cardRole === 'outro' ? 'full-frame YouTube closing title card' : 'YouTube opening title card'} as one professional ${isVertical ? 'vertical 9:16' : 'widescreen 16:9'} image.
SEO packaging title: "${seoTitle || videoTitle || cardTitle}"
Visual concept: ${concept}
${channelName ? `Channel brand: "${channelName}"${channelNiche ? ` — ${channelNiche}` : ''}.` : ''}

BAKE THIS EXACT COPY INTO THE IMAGE:
- Main title: "${cardTitle || videoTitle || ''}"
- Supporting line: "${cardSubtitle || ''}"
${channelName ? `- Small channel signature: "${channelName}"` : ''}

Creative direction:
- The main title is the dominant graphic element: huge, bold, high-contrast, professionally typeset, and readable on a phone. Preserve the exact spelling and do not add other words.
- Build one instantly understood visual idea that complements the SEO title instead of merely illustrating every word.
- Use one dominant expressive face with a strong authentic reaction (surprise, awe, urgency, delight, or discovery) when a person/character fits the subject. Otherwise use an equally powerful reveal, transformation, scale contrast, or visual mystery.
- Create a clear curiosity gap and a big visual surprise without clickbait deception. Use no more than three meaningful visual elements.
- Match the attached channel references closely: recurring character identity, color palette, lighting, rendering style, and recognizable brand motifs. Do not copy their composition.
- Keep title, face, and focal reveal separated with strong silhouette and foreground/background contrast. Avoid clutter and tiny details.
- Keep every letter at least 8% inside all image edges so no title, supporting line, or channel signature can be cropped by video framing.
- Place all typography within the central 84% safe area: title and supporting line around the middle third, with the small channel signature immediately beneath them rather than against an edge.
- ${cardRole === 'outro' ? 'Make the image feel like the next reveal in the story. Fill the whole frame naturally; do not reserve blank regions or create video placeholders.' : 'Make the first frame feel like premium YouTube packaging that immediately earns attention.'}
- No watermarks, platform logos, fake interface chrome, extra captions, or illegible decorative lettering.`;
    } else {
      prompt = `${refBlock}
Design a click-worthy viral ${isVertical ? 'vertical 9:16 Instagram Reel cover' : 'YouTube thumbnail (16:9)'} image.
Video Title: "${videoTitle || concept}"
Concept: ${concept}
Requirements: communicate in one second on a phone screen. Use one dominant focal subject,
a clean silhouette, strong foreground/background separation, and one unmistakable emotion,
transformation, contrast, or visual mystery. The image must add a new curiosity layer to the title,
never repeat the title or cram in multiple ideas. Use no more than three meaningful visual elements.
If the concept includes a short text overlay (under 4 words), render it big and legible; otherwise use no text.
No watermarks, no channel logos.`;
    }

    // Image parts (references) precede the text instruction
    const contentParts = refs.map(r => {
      const mimeMatch = r.match(/^data:(image\/\w+);base64,/);
      return {
        inlineData: {
          mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
          data: r.replace(/^data:image\/\w+;base64,/, '')
        }
      };
    });
    contentParts.push({ text: prompt });

    // Try current image-capable Gemini models in order. Finished cards are visually
    // audited and regenerated with critique instead of accepting malformed typography.
    const models = GEMINI_IMAGE_MODELS;
    let imageBase64 = null;
    let lastErr = null;
    let retryInstruction = '';
    const maxAttempts = kind === 'card-bg' ? 10 : models.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const model = models[attempt % models.length];
      try {
        const attemptParts = contentParts.slice(0, -1);
        attemptParts.push({ text: `${prompt}${retryInstruction ? `\n\nMANDATORY CORRECTION FROM THE PREVIOUS DESIGN REVIEW:\n${retryInstruction}` : ''}` });
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: attemptParts }],
              generationConfig: { responseModalities: ["IMAGE"] }
            })
          }
        );
        if (!resp.ok) {
          lastErr = new Error(`${model}: status ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find(p => p.inlineData && p.inlineData.data);
        if (imgPart) {
          const candidate = imgPart.inlineData.data;
          if (kind !== 'card-bg') {
            imageBase64 = candidate;
            console.log(`Thumbnail generated with ${model}`);
            break;
          }
          const review = await reviewGeneratedCard(candidate, { cardTitle, cardSubtitle, channelName, cardRole });
          console.log(`Card review attempt ${attempt + 1}: approved=${review.approved}, score=${review.score}`);
          const passedReview = review.approved && review.exactCopy && review.safeMargins &&
            review.noExtraTextOrUi && review.strongPackaging;
          if (passedReview) {
            imageBase64 = candidate;
            break;
          }
          retryInstruction = review.retryInstruction || (review.issues || []).join('; ');
          lastErr = new Error(`card review failed: ${(review.issues || []).join('; ')}`);
          continue;
        }
        lastErr = new Error(`${model}: no image in response`);
      } catch (err) {
        lastErr = err;
      }
    }

    if (!imageBase64) {
      throw new Error(`Image generation unavailable: ${lastErr ? lastErr.message : 'unknown'}`);
    }

    // Conform to exact platform dimensions
    const rawPath = path.join(outputsDir, `thumb_raw_${Date.now()}.png`);
    tempFiles.push(rawPath);
    await fs.promises.writeFile(rawPath, Buffer.from(imageBase64, 'base64'));

    const w = isVertical ? 1080 : 1280;
    const h = isVertical ? 1920 : 720;
    const thumbFilename = `thumbnail_${Date.now()}.png`;
    const thumbPath = path.join(outputsDir, thumbFilename);
    await execAsync(`ffmpeg -y -i "${rawPath}" -vf "scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}" "${thumbPath}"`);

    res.json({ success: true, url: `/outputs/${thumbFilename}`, filename: thumbFilename });
  } catch (error) {
    console.error("Thumbnail generation error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
});

// Publish package: zip the master video + subtitles + YouTube metadata in one download
app.post('/api/export-package', async (req, res) => {
  const tempFiles = [];
  try {
    const { videoFilename, srtContent = '', metadataContent = '', thumbnailFilenames = [] } = req.body;

    const safeVideo = sanitizeFilename(videoFilename);
    if (!safeVideo) return res.status(400).json({ error: "Missing rendered video filename — render the video first" });
    const videoPath = path.join(outputsDir, safeVideo);
    if (!fs.existsSync(videoPath)) return res.status(400).json({ error: "Rendered video not found — render it again" });

    const stamp = Date.now();
    const filesToZip = [videoPath];

    if (srtContent.trim()) {
      const srtPath = path.join(outputsDir, `subtitles_${stamp}.srt`);
      await fs.promises.writeFile(srtPath, srtContent);
      tempFiles.push(srtPath);
      filesToZip.push(srtPath);
    }
    if (metadataContent.trim()) {
      const metaPath = path.join(outputsDir, `youtube-metadata_${stamp}.txt`);
      await fs.promises.writeFile(metaPath, metadataContent);
      tempFiles.push(metaPath);
      filesToZip.push(metaPath);
    }
    for (const t of thumbnailFilenames) {
      const safeThumb = sanitizeFilename(t);
      if (safeThumb && fs.existsSync(path.join(outputsDir, safeThumb))) {
        filesToZip.push(path.join(outputsDir, safeThumb));
      }
    }

    const zipFilename = `publish_package_${stamp}.zip`;
    const zipPath = path.join(outputsDir, zipFilename);
    const zipCmd = `zip -j "${zipPath}" ${filesToZip.map(f => `"${f}"`).join(' ')}`;
    console.log("Building publish package:", zipCmd);
    await execAsync(zipCmd);

    res.json({ success: true, url: `/outputs/${zipFilename}`, files: filesToZip.length });
  } catch (error) {
    console.error("Publish package error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
});

// Cloud-safe slug for library folder names
function librarySlug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60) || 'untitled';
}

// Organize every artifact a project references into a browsable per-project folder,
// in BOTH places, so you can find "all files for project X" at a glance:
//   local: public/outputs/projects/<project-slug>/   (hardlinks — no extra disk)
//   GCS:   library/projects/<project-slug>/
// The flat outputs/ store stays the working cache (pull-through + generators rely
// on it); this is an additional, human-friendly index. Re-run any time to refresh.
app.post('/api/project/organize', async (req, res) => {
  try {
    const { projectName, files } = req.body; // files: [{ filename, role? }]
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "No files to organize" });
    }
    const slug = librarySlug(projectName);
    const localDir = path.join(outputsDir, 'projects', slug);
    await fs.promises.mkdir(localDir, { recursive: true });

    const result = { slug, localFolder: `outputs/projects/${slug}`, gcsPrefix: null, organized: [], missing: [] };
    const toArchive = [];
    const manifest = [];
    for (const f of files) {
      const name = sanitizeFilename(f.filename);
      if (!name) continue;
      const src = path.join(outputsDir, name);
      if (!fs.existsSync(src)) { result.missing.push(name); continue; }
      // role prefix keeps the folder self-describing (scene_01_..., song_..., master_...)
      const destName = f.role ? `${f.role}_${name}` : name;
      const dest = path.join(localDir, destName);
      await fs.promises.unlink(dest).catch(() => {});
      try { await fs.promises.link(src, dest); }          // hardlink: same bytes, no copy
      catch { await fs.promises.copyFile(src, dest); }     // cross-device fallback
      result.organized.push(name);
      manifest.push({ file: destName, source: name, role: f.role || null });
      toArchive.push({ path: src, name: destName });
    }

    // Manifest so the folder is self-explanatory
    const manifestPath = path.join(localDir, 'manifest.json');
    await fs.promises.writeFile(manifestPath, JSON.stringify({
      projectName: projectName || slug, organizedAt: new Date().toISOString(), files: manifest
    }, null, 2));

    // Mirror the organized set to GCS under library/projects/<slug>/
    if (cloud.storageEnabled && toArchive.length) {
      toArchive.push({ path: manifestPath, name: 'manifest.json' });
      const arch = await archiveToLibrary(`projects/${slug}`, toArchive);
      result.gcsPrefix = arch.path;
    }

    console.log(`Organized ${result.organized.length} artifact(s) for "${projectName}" → ${result.localFolder}`);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Project organize error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Archive a finished video's deliverables to the organized GCS library:
// library/<channel-slug>/<yyyy-mm-dd>_<video-slug>/{master.mp4, thumbnail, shorts, subtitles.srt, metadata.txt}
app.post('/api/archive-render', async (req, res) => {
  const tempFiles = [];
  try {
    if (!cloud.storageEnabled) {
      return res.status(400).json({ error: "Cloud Storage is not configured (set GCS_BUCKET in .env)" });
    }
    const { channelName = '', title = '', videoFilename, thumbnailFilenames = [], shortFilenames = [], srtContent = '', metadataContent = '' } = req.body;

    const safeVideo = sanitizeFilename(videoFilename);
    if (!safeVideo || !fs.existsSync(path.join(outputsDir, safeVideo))) {
      return res.status(400).json({ error: "Rendered video not found — render it first" });
    }

    const date = new Date().toISOString().slice(0, 10);
    const prefix = `${librarySlug(channelName) || 'no-channel'}/${date}_${librarySlug(title)}`;

    const files = [{ path: path.join(outputsDir, safeVideo), name: 'master.mp4' }];
    thumbnailFilenames.forEach((t, i) => {
      const safe = sanitizeFilename(t);
      if (safe && fs.existsSync(path.join(outputsDir, safe))) {
        files.push({ path: path.join(outputsDir, safe), name: `thumbnail_${i + 1}${path.extname(safe)}` });
      }
    });
    shortFilenames.forEach((t, i) => {
      const safe = sanitizeFilename(t);
      if (safe && fs.existsSync(path.join(outputsDir, safe))) {
        files.push({ path: path.join(outputsDir, safe), name: `short_${i + 1}.mp4` });
      }
    });
    if (srtContent.trim()) {
      const p = path.join(outputsDir, `lib_srt_${Date.now()}.srt`);
      await fs.promises.writeFile(p, srtContent);
      tempFiles.push(p);
      files.push({ path: p, name: 'subtitles.srt' });
    }
    if (metadataContent.trim()) {
      const p = path.join(outputsDir, `lib_meta_${Date.now()}.txt`);
      await fs.promises.writeFile(p, metadataContent);
      tempFiles.push(p);
      files.push({ path: p, name: 'youtube-metadata.txt' });
    }

    const result = await archiveToLibrary(prefix, files);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Library archive error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
});

// Auto-Shorts: cut the best moments out of a finished master render and convert
// them to vertical 9:16 Shorts. Segment selection is AI-driven from the timed
// subtitle/narration lines (final-video timeline); falls back to heuristics.
app.post('/api/generate-shorts', async (req, res) => {
  try {
    const { videoFilename, lines = [], count = 2, style = 'blur', topic = '' } = req.body;

    const safeVideo = sanitizeFilename(videoFilename);
    if (!safeVideo) return res.status(400).json({ error: "Missing rendered video filename — render the master first" });
    const videoPath = path.join(outputsDir, safeVideo);
    if (!fs.existsSync(videoPath)) return res.status(400).json({ error: "Rendered video not found — render it again" });

    const { stdout: durOut } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`);
    const videoDur = parseFloat(durOut.trim());
    if (!videoDur || videoDur < 6) return res.status(400).json({ error: "Video too short to cut Shorts from" });

    const { stdout: dimOut } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`);
    const [srcW, srcH] = dimOut.trim().split(',').map(Number);
    const alreadyVertical = srcH > srcW;

    const wanted = Math.min(3, Math.max(1, parseInt(count, 10) || 2));
    const maxLen = Math.min(58, videoDur);
    const minLen = Math.min(15, Math.max(6, videoDur * 0.4));

    // --- Pick segments: AI over the timed lines, else heuristic windows ---
    let segments = [];
    const usableLines = (Array.isArray(lines) ? lines : [])
      .filter(l => l && l.text && isFinite(+l.start))
      .map(l => ({ text: String(l.text).slice(0, 120), start: +l.start, end: +l.end || (+l.start + 3) }));

    if (usableLines.length >= 3 && videoDur > 20) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const prompt = `
You are a YouTube Shorts editor. A finished ${Math.round(videoDur)}-second video${topic ? ` about "${topic}"` : ''} has these timed subtitle/narration lines (seconds from the start of the video):

${usableLines.map(l => `[${l.start.toFixed(1)} - ${l.end.toFixed(1)}] ${l.text}`).join('\n')}

Choose the ${wanted} BEST self-contained segments to publish as vertical Shorts.
Rules:
- Each segment: between ${Math.round(minLen)} and ${Math.round(maxLen)} seconds long, within [0, ${videoDur.toFixed(1)}].
- Prefer the hook/chorus/most emotionally engaging or most surprising part; a Short must grab attention in its first 2 seconds.
- Segments must NOT overlap. Start/end at natural line boundaries (a line's start / a line's end), slightly padded is fine.
- For each, write "title": a punchy Shorts title under 60 chars (no hashtags), and "reason": one short sentence why this moment works as a Short.
Return them ordered best-first, conforming to the response schema.`;

        const aiRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  segments: {
                    type: "ARRAY",
                    items: {
                      type: "OBJECT",
                      properties: {
                        startSec: { type: "NUMBER" },
                        endSec: { type: "NUMBER" },
                        title: { type: "STRING" },
                        reason: { type: "STRING" }
                      },
                      required: ["startSec", "endSec", "title"]
                    }
                  }
                },
                required: ["segments"]
              }
            }
          })
        });
        if (aiRes.ok) {
          const data = await aiRes.json();
          const parsed = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
          segments = (parsed.segments || [])
            .map(s => ({
              start: Math.max(0, +s.startSec || 0),
              end: Math.min(videoDur, +s.endSec || 0),
              title: (s.title || '').slice(0, 90),
              reason: s.reason || ''
            }))
            .filter(s => s.end - s.start >= 5)
            .slice(0, wanted);
        }
      } catch (err) {
        console.warn("Shorts AI segment selection failed, using heuristic:", err.message);
      }
    }

    if (segments.length === 0) {
      // Heuristic: whole video if short; else evenly spread windows skipping the first/last 5%
      if (videoDur <= maxLen) {
        segments = [{ start: 0, end: videoDur, title: topic ? `${topic}`.slice(0, 90) : 'Highlight', reason: 'Whole video fits Shorts length' }];
      } else {
        const len = Math.min(maxLen, Math.max(minLen, 30));
        const usable = videoDur * 0.9;
        const step = Math.max(len, (usable - len) / Math.max(1, wanted - 1));
        for (let i = 0; i < wanted; i++) {
          const start = Math.min(videoDur - len, videoDur * 0.05 + i * step);
          segments.push({ start, end: start + len, title: `Highlight ${i + 1}`, reason: 'Evenly sampled window' });
          if (start + len >= videoDur - 1) break;
        }
      }
    }

    // --- Render each segment vertical ---
    const enc = getHardwareVideoEncoder();
    const results = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDur = seg.end - seg.start;
      const outName = `short_${Date.now()}_${i}.mp4`;
      const outPath = path.join(outputsDir, outName);

      let vf;
      if (alreadyVertical) {
        vf = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2`;
      } else if (style === 'crop') {
        // Fill the frame: scale to 1920 tall, center-crop 1080 wide
        vf = `scale=-2:1920,crop=1080:1920`;
      } else {
        // Blurred-background letterbox: full frame visible on a blurred fill
        vf = `split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=22:3[b];[fg]scale=1080:-2[f];[b][f]overlay=(W-w)/2:(H-h)/2`;
      }
      // End CTA + gentle audio fade-out
      let post = '';
      if (ffmpegHasDrawtext && segDur > 8) {
        const cta = 'Full video on the channel!'.replace(/'/g, "'\\\\''");
        post = `,drawtext=text='${cta}':fontcolor=white:fontsize=52:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.80:font='Arial':enable='gte(t,${(segDur - 2.5).toFixed(2)})'`;
      }

      const cmd = `ffmpeg -y -ss ${seg.start.toFixed(2)} -t ${segDur.toFixed(2)} -i "${videoPath}" -filter_complex "[0:v]${vf}${post}[v];[0:a]afade=t=out:st=${Math.max(0, segDur - 0.6).toFixed(2)}:d=0.6[a]" -map "[v]" -map "[a]" ${enc} -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "${outPath}"`;
      console.log(`Cutting Short ${i + 1}/${segments.length}: ${seg.start.toFixed(1)}s → ${seg.end.toFixed(1)}s`);
      await execAsync(cmd);

      results.push({
        filename: outName,
        url: `/outputs/${outName}`,
        title: seg.title,
        reason: seg.reason,
        startSec: Math.round(seg.start * 10) / 10,
        endSec: Math.round(seg.end * 10) / 10,
        duration: Math.round(segDur * 10) / 10
      });
    }

    res.json({ success: true, shorts: results, aiSelected: usableLines.length >= 3 && videoDur > 20 && results.length > 0 && results[0].reason !== 'Evenly sampled window' });
  } catch (error) {
    console.error("Auto-Shorts error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Conversational scene refinement: edit an existing generated clip via
// previous_interaction_id instead of regenerating from scratch (Interactions API multi-turn)
app.post('/api/refine-scene', async (req, res) => {
  try {
    const { interactionId, instruction, sceneIndex, aspectRatio } = req.body;

    if (!interactionId) {
      return res.status(400).json({ error: "Missing interactionId — regenerate the scene once to enable editing" });
    }
    if (!instruction || !instruction.trim()) {
      return res.status(400).json({ error: "Missing edit instruction" });
    }

    const safeAspect = aspectRatio === '9:16' ? '9:16' : '16:9';
    const requestBody = {
      model: "gemini-omni-flash-preview",
      previous_interaction_id: interactionId,
      input: [{ type: "text", text: instruction.trim() }],
      response_format: { type: "video", aspect_ratio: safeAspect }
    };

    console.log(`Refining scene ${(sceneIndex ?? 0) + 1} (interaction ${interactionId}): "${instruction.trim()}"`);

    const apiResponse = await fetch(INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Revision': '2026-05-20'
      },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error("Refine error:", errorText.slice(0, 300));
      throw new Error(`Gemini API returned status ${apiResponse.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await apiResponse.json();
    let videoBase64 = null;
    if (data.steps && Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (step.type === 'model_output' && step.content) {
          const videoContent = step.content.find(item => item.type === 'video' && item.data);
          if (videoContent) { videoBase64 = videoContent.data; break; }
        }
      }
    }
    if (!videoBase64) throw new Error("No video content returned for the refinement");

    const newInteractionId = data.id || (data.name ? data.name.split('/').pop() : null);
    const filename = `scene_refined_${Date.now()}_${sceneIndex ?? 0}.mp4`;
    await fs.promises.writeFile(path.join(outputsDir, filename), Buffer.from(videoBase64, 'base64'));
    await persistMirror(filename);

    console.log(`Refined scene saved: ${filename}`);
    res.json({ success: true, videoUrl: `/outputs/${filename}`, filename, interactionId: newInteractionId });
  } catch (error) {
    console.error("Scene refinement error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ==========================================================================
   Free stock video (b-roll) — back a narrative with real footage instead of
   always AI-generating. Pexels (best) or Pixabay via free API keys.
   ========================================================================== */

// Search stock providers; returns normalized clips. Tries whichever keys are set.
async function searchStock(query, perPage = 12) {
  const PEXELS = process.env.PEXELS_API_KEY;
  const PIXABAY = process.env.PIXABAY_API_KEY;

  if (PEXELS) {
    const resp = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`, {
      headers: { Authorization: PEXELS }
    });
    if (!resp.ok) throw new Error(`Pexels API ${resp.status}`);
    const data = await resp.json();
    return (data.videos || []).map(v => {
      // Pick the best mp4 ≤1080p (smaller files, fast to fetch)
      const files = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && (f.height || 0) <= 1080)
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      const best = files[0] || (v.video_files || [])[0];
      return best ? {
        id: `pexels_${v.id}`, provider: 'Pexels', thumb: v.image,
        videoUrl: best.link, width: best.width, height: best.height,
        duration: v.duration, author: v.user ? v.user.name : '', pageUrl: v.url
      } : null;
    }).filter(Boolean);
  }

  if (PIXABAY) {
    const resp = await fetch(`https://pixabay.com/api/videos/?key=${PIXABAY}&q=${encodeURIComponent(query)}&per_page=${perPage}`);
    if (!resp.ok) throw new Error(`Pixabay API ${resp.status}`);
    const data = await resp.json();
    return (data.hits || []).map(h => {
      const vids = h.videos || {};
      const best = vids.large || vids.medium || vids.small;
      return best ? {
        id: `pixabay_${h.id}`, provider: 'Pixabay', thumb: (vids.medium || vids.small || {}).thumbnail || '',
        videoUrl: best.url, width: best.width, height: best.height,
        duration: h.duration, author: h.user || '', pageUrl: h.pageURL
      } : null;
    }).filter(Boolean);
  }

  return null; // no provider configured
}

app.get('/api/stock/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: "Missing search query" });
    const results = await searchStock(q, 12);
    if (results === null) {
      return res.json({
        enabled: false,
        error: "No stock provider configured. Add a free PEXELS_API_KEY (pexels.com/api) or PIXABAY_API_KEY to .env.",
        results: []
      });
    }
    res.json({ enabled: true, results });
  } catch (error) {
    console.error("Stock search error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Download a chosen stock clip and conform it to a usable scene mp4
app.post('/api/stock/use', async (req, res) => {
  const tempFiles = [];
  try {
    const { videoUrl, sceneIndex = 0, orientation = 'landscape' } = req.body;
    if (!videoUrl || !/^https:\/\//.test(videoUrl)) {
      return res.status(400).json({ error: "Missing/invalid stock video URL" });
    }

    const resp = await fetch(videoUrl);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const rawPath = path.join(outputsDir, `stock_raw_${Date.now()}.mp4`);
    tempFiles.push(rawPath);
    await fs.promises.writeFile(rawPath, buf);

    // Conform to the project's output frame so the rest of the pipeline just works
    const { w, h } = getOutputDims(orientation === 'vertical' ? 'vertical' : 'landscape');
    const enc = getHardwareVideoEncoder();
    const filename = `scene_stock_${Date.now()}_${sceneIndex}.mp4`;
    const outPath = path.join(outputsDir, filename);
    await execAsync(`ffmpeg -y -i "${rawPath}" -t 12 -vf "scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=30" -an ${enc} -pix_fmt yuv420p "${outPath}"`);

    console.log(`Stock clip ready: ${filename}`);
    await persistMirror(filename);
    res.json({ success: true, videoUrl: `/outputs/${filename}`, filename });
  } catch (error) {
    console.error("Stock use error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
});

// Standard Merge endpoint
app.post('/api/merge-video', async (req, res) => {
  try {
    const { filenames } = req.body;

    if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
      return res.status(400).json({ error: "Missing filenames array" });
    }

    // Sanitize and validate all filenames
    const safeFilenames = filenames.map(f => sanitizeFilename(f)).filter(Boolean);
    if (safeFilenames.length !== filenames.length) {
      return res.status(400).json({ error: "Invalid filename characters detected" });
    }

    console.log("Merging videos:", safeFilenames);

    const inputsContent = safeFilenames
      .map(file => `file '${path.join(outputsDir, file)}'`)
      .join('\n');

    const inputsFilePath = path.join(outputsDir, `inputs_${Date.now()}.txt`);
    await fs.promises.writeFile(inputsFilePath, inputsContent);

    const mergedFilename = `merged_${Date.now()}.mp4`;
    const mergedFilePath = path.join(outputsDir, mergedFilename);

    const command = `ffmpeg -y -f concat -safe 0 -i "${inputsFilePath}" -c copy "${mergedFilePath}"`;

    console.log("Running FFmpeg command:", command);
    await execAsync(command);

    fs.unlink(inputsFilePath, (err) => {
      if (err) console.error("Error deleting temp input file:", err);
    });

    console.log(`Successfully merged into ${mergedFilePath}`);

    res.json({
      success: true,
      videoUrl: `/outputs/${mergedFilename}`
    });

  } catch (error) {
    console.error("Error merging videos:", error);
    res.status(500).json({ error: error.message });
  }
});

// Conformed & Audio Synced Merge endpoint using FFmpeg
app.post('/api/merge-video-sync', async (req, res) => {
  try {
    const { audioFilename, scenes } = req.body;

    if (!audioFilename || !scenes || !Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: "Missing audioFilename or scenes array" });
    }

    const safeAudioFilename = sanitizeFilename(audioFilename);
    if (!safeAudioFilename) {
      return res.status(400).json({ error: "Invalid audio filename characters detected" });
    }

    console.log(`Syncing video with audio ${safeAudioFilename}:`, scenes);

    const conformedPaths = [];

    // Step 1: Conform each video clip to its segment duration (loop if longer, trim if shorter)
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const safeSceneFilename = sanitizeFilename(scene.filename);
      if (!safeSceneFilename) {
        return res.status(400).json({ error: "Invalid scene filename characters detected" });
      }
      
      const duration = parseFloat(scene.duration);
      if (isNaN(duration) || duration <= 0) {
        return res.status(400).json({ error: "Invalid scene duration" });
      }

      const inputPath = path.join(outputsDir, safeSceneFilename);
      const outputPath = path.join(outputsDir, `conformed_${i}_${Date.now()}.mp4`);
      
      let conformCmd;
      if (duration > 10.0) {
        // Loop the clip to cover the longer duration, strip audio with -an
        conformCmd = `ffmpeg -y -stream_loop -1 -i "${inputPath}" -t ${duration} -an "${outputPath}"`;
      } else {
        // Trim the clip to cover the shorter duration, strip audio with -an
        conformCmd = `ffmpeg -y -i "${inputPath}" -t ${duration} -an "${outputPath}"`;
      }
      
      console.log(`Conforming scene ${i+1} (${duration > 10.0 ? 'looping' : 'trimming'} to ${duration}s): ${conformCmd}`);
      await execAsync(conformCmd);
      conformedPaths.push(outputPath);
    }

    // Step 2: Concatenate silent conformed clips
    const inputsContent = conformedPaths
      .map(filePath => `file '${filePath}'`)
      .join('\n');

    const inputsFilePath = path.join(outputsDir, `inputs_sync_${Date.now()}.txt`);
    await fs.promises.writeFile(inputsFilePath, inputsContent);

    const mergedSilentPath = path.join(outputsDir, `merged_silent_${Date.now()}.mp4`);
    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${inputsFilePath}" -c copy "${mergedSilentPath}"`;

    console.log(`Concatenating silent clips: ${concatCmd}`);
    await execAsync(concatCmd);

    // Step 3: Overlay the uploaded audio file on top of the conformed video
    const finalFilename = `synced_${Date.now()}.mp4`;
    const finalFilePath = path.join(outputsDir, finalFilename);
    const audioPath = path.join(outputsDir, safeAudioFilename);

    const mergeAudioCmd = `ffmpeg -y -i "${mergedSilentPath}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v -map 1:a -shortest "${finalFilePath}"`;

    console.log(`Merging audio file: ${mergeAudioCmd}`);
    await execAsync(mergeAudioCmd);

    // Step 4: Cleanup temporary files
    conformedPaths.forEach(file => {
      fs.unlink(file, (err) => { if (err) console.error("Error deleting conformed file:", err); });
    });
    fs.unlink(inputsFilePath, (err) => { if (err) console.error("Error deleting inputs file:", err); });
    fs.unlink(mergedSilentPath, (err) => { if (err) console.error("Error deleting silent merged file:", err); });

    console.log(`Successfully compiled synced music video at ${finalFilePath}`);

    res.json({
      success: true,
      videoUrl: `/outputs/${finalFilename}`
    });

  } catch (error) {
    console.error("Error conforming/merging videos:", error);
    res.status(500).json({ error: error.message });
  }
});

// Hardware-accelerated Video Encoder selector
function getHardwareVideoEncoder() {
  if (process.platform === 'darwin') {
    return '-c:v h264_videotoolbox -b:v 6M';
  }
  return '-c:v libx264 -preset fast -crf 22';
}

// Format seconds into ASS time format: H:MM:SS.cs (e.g. 0:01:23.45)
function formatASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Helper to convert hex color to ASS BGR format (&HBBGGRR&)
function hexToASSColor(hexStr, alpha = 0) {
  let cleanHex = hexStr.replace('#', '');
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }
  const r = cleanHex.substring(0, 2);
  const g = cleanHex.substring(2, 4);
  const b = cleanHex.substring(4, 6);
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}&`.toUpperCase();
}

// Generate ASS (Advanced SubStation Alpha) subtitle file
// Resolve output dimensions from orientation ('vertical' → 720x1280, else 1280x720)
function getOutputDims(orientation) {
  return orientation === 'vertical'
    ? { w: 720, h: 1280 }
    : { w: 1280, h: 720 };
}

function buildASSContent(lyrics, style = {}, orientation = 'landscape') {
  const { w: resX, h: resY } = getOutputDims(orientation);
  const fontSize = style.fontSize || 32;
  const primaryColor = hexToASSColor(style.fontColor || '#FFFFFF', 0);
  const outlineColor = hexToASSColor(style.strokeColor || '#000000', 0);
  const backColor = hexToASSColor(style.bgColor || '#000000', style.bgOpacity !== undefined ? style.bgOpacity : 0.5);
  const borderStyle = style.bgBox ? 3 : 1; // 3 = opaque box, 1 = outline + shadow
  const alignment = style.position === 'top' ? 8 : (style.position === 'center' ? 5 : 2); // ASS alignment: 2=bottom, 5=center, 8=top
  const marginV = style.position === 'bottom' ? 40 : 20;

  let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${resX}
PlayResY: ${resY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},${primaryColor},&H00000000&,${outlineColor},${backColor},-1,0,0,0,100,100,0,0,${borderStyle},2,1,${alignment},20,20,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  lyrics.forEach(item => {
    if (!item.text || !item.text.trim()) return;
    const startStr = formatASSTime(item.startTime || 0);
    const endStr = formatASSTime((item.startTime || 0) + (item.duration || 3));
    const cleanText = item.text.replace(/\n/g, '\\N');
    ass += `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${cleanText}\n`;
  });

  return ass;
}

// Synthesize one narration line with Gemini 3.1 Flash Audio via the Interactions API
// (same natural-audio family as Gemini 3.1 Flash Live; the TTS variant is the batch one)
async function synthesizeLineGemini31(text, voice, outWavPath, tempFiles) {
  const requestBody = {
    model: "gemini-3.1-flash-tts-preview",
    input: text,
    response_format: { type: "audio" },
    generation_config: {
      speech_config: [{ voice: voice }]
    }
  };

  const resp = await fetch(INTERACTIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Revision': '2026-05-20'
    },
    body: JSON.stringify(requestBody)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini 3.1 TTS status ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  let audioBase64 = null;
  if (data.steps && Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (step.type === 'model_output' && step.content) {
        const audioContent = step.content.find(item => item.type === 'audio' && item.data);
        if (audioContent) {
          audioBase64 = audioContent.data;
          break;
        }
      }
    }
  }
  if (!audioBase64) throw new Error("No audio returned by Gemini 3.1 TTS");

  const audioBuffer = Buffer.from(audioBase64, 'base64');
  // Output is 24kHz 16-bit mono — either a WAV container ("RIFF" magic) or raw PCM
  if (audioBuffer.subarray(0, 4).toString('ascii') === 'RIFF') {
    await fs.promises.writeFile(outWavPath, audioBuffer);
  } else {
    const pcmPath = outWavPath.replace(/\.wav$/, '.pcm');
    await fs.promises.writeFile(pcmPath, audioBuffer);
    tempFiles.push(pcmPath);
    await execAsync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${pcmPath}" "${outWavPath}"`);
  }
}

// Synthesize one narration line with Gemini 2.5 TTS (returns 24kHz s16le mono PCM)
async function synthesizeLineGemini25(text, voice, outWavPath, tempFiles) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
      }
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini TTS status ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const audioPart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.data);
  if (!audioPart) throw new Error("No audio returned by Gemini TTS");

  const pcmPath = outWavPath.replace(/\.wav$/, '.pcm');
  await fs.promises.writeFile(pcmPath, Buffer.from(audioPart.inlineData.data, 'base64'));
  tempFiles.push(pcmPath);
  await execAsync(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${pcmPath}" "${outWavPath}"`);
}

// Fallback: synthesize one narration line with the local macOS `say` voice
async function synthesizeLineSay(text, outWavPath, tempFiles) {
  // Write the text to a file so no user text ever touches the shell command line
  const txtPath = outWavPath.replace(/\.wav$/, '.txt');
  await fs.promises.writeFile(txtPath, text);
  tempFiles.push(txtPath);

  const aiffPath = outWavPath.replace(/\.wav$/, '.aiff');
  await execAsync(`say -f "${txtPath}" -o "${aiffPath}"`);
  tempFiles.push(aiffPath);
  await execAsync(`ffmpeg -y -i "${aiffPath}" -ar 24000 -ac 1 "${outWavPath}"`);
}

// Generate a timed TTS narration track from script lines
// Synthesize a timed voiceover track from lines [{text, startTime}] with fallbacks.
// Returns { filename, duration, engine }. Caller cleans up nothing (temp files self-managed).
async function synthesizeTimedNarration(lines, voice = 'Kore', tag = 'narration') {
  const tempFiles = [];
  try {
    const stamp = Date.now();
    const lineWavs = [];
    let engine = 'gemini-3.1'; // 3.1 Flash Audio → 2.5 TTS → local 'say'

    for (let i = 0; i < lines.length; i++) {
      const text = String(lines[i].text || '').trim();
      if (!text) continue;

      const wavPath = path.join(outputsDir, `tts_line_${stamp}_${i}.wav`);
      let synthesized = false;

      if (engine === 'gemini-3.1') {
        try { await synthesizeLineGemini31(text, voice, wavPath, tempFiles); synthesized = true; }
        catch (err) { console.warn(`Gemini 3.1 Flash Audio failed (${err.message}) — falling back to Gemini 2.5 TTS`); engine = 'gemini-2.5'; }
      }
      if (!synthesized && engine === 'gemini-2.5') {
        try { await synthesizeLineGemini25(text, voice, wavPath, tempFiles); synthesized = true; }
        catch (err) { console.warn(`Gemini 2.5 TTS failed (${err.message}) — falling back to local 'say' voice`); engine = 'say'; }
      }
      if (!synthesized) {
        if (process.platform !== 'darwin') throw new Error("TTS unavailable: Gemini TTS failed and no local fallback on this platform");
        await synthesizeLineSay(text, wavPath, tempFiles);
      }

      tempFiles.push(wavPath);
      lineWavs.push({ path: wavPath, delayMs: Math.max(0, Math.round((parseFloat(lines[i].startTime) || 0) * 1000)) });
    }

    if (lineWavs.length === 0) throw new Error("No narration lines could be synthesized");

    const outFilename = `${tag}_${stamp}.m4a`;
    const outPath = path.join(outputsDir, outFilename);
    const inputArgs = lineWavs.map(l => `-i "${l.path}"`).join(' ');
    const delayFilters = lineWavs.map((l, i) => `[${i}:a]aresample=44100,adelay=${l.delayMs}|${l.delayMs}[a${i}]`).join(';');
    const amixInputs = lineWavs.map((_, i) => `[a${i}]`).join('');
    const mixCmd = `ffmpeg -y ${inputArgs} -filter_complex "${delayFilters};${amixInputs}amix=inputs=${lineWavs.length}:duration=longest:normalize=0[aout]" -map "[aout]" -c:a aac "${outPath}"`;
    await execAsync(mixCmd);

    const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outPath}"`);
    return { filename: outFilename, duration: parseFloat(stdout.trim()), engine };
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
}

app.post('/api/generate-narration', async (req, res) => {
  try {
    const { lines, voice = 'Kore' } = req.body;
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: "Missing narration lines array" });
    }
    console.log(`Synthesizing ${lines.length} narration lines (voice: ${voice})...`);
    const result = await synthesizeTimedNarration(lines, voice, 'narration');
    console.log(`Narration track ready: ${result.filename} (${result.duration}s, engine: ${result.engine})`);
    if (result.filename) await persistMirror(result.filename);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Narration generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Language catalog for localization (label + a suitable multilingual voice)
const LOCALE_LANGUAGES = {
  es: { name: 'Spanish', voice: 'Kore' },
  pt: { name: 'Portuguese (Brazil)', voice: 'Kore' },
  fr: { name: 'French', voice: 'Aoede' },
  de: { name: 'German', voice: 'Charon' },
  hi: { name: 'Hindi', voice: 'Kore' },
  ja: { name: 'Japanese', voice: 'Leda' },
  it: { name: 'Italian', voice: 'Aoede' },
   id: { name: 'Indonesian', voice: 'Kore' },
  ar: { name: 'Arabic', voice: 'Charon' },
  ko: { name: 'Korean', voice: 'Leda' }
};

// Localize a video: translate the narration/lyrics lines, synthesize a native
// voiceover, and return translated lines (for captions). Visuals stay untouched —
// upload once and add these as YouTube multi-language audio + caption tracks.
app.post('/api/localize', async (req, res) => {
  try {
    const { lines, langCode, voice } = req.body;
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: "Missing lines to localize" });
    }
    const lang = LOCALE_LANGUAGES[langCode];
    if (!lang) return res.status(400).json({ error: `Unsupported language: ${langCode}` });

    // Translate line-by-line preserving order & count (so timings still line up)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const numbered = lines.map((l, i) => `${i + 1}. ${l.text}`).join('\n');
    const prompt = `Translate these ${lines.length} short video narration lines into ${lang.name}.
Keep the SAME number of lines in the SAME order. Natural, spoken, concise — match each line's length so it fits the same on-screen time. Do not add or merge lines.

${numbered}

Return JSON conforming to the schema (an array "lines" of exactly ${lines.length} translated strings, in order).`;

    const apiResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: { type: 'OBJECT', properties: { lines: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['lines'] }
        }
      })
    });
    if (!apiResp.ok) throw new Error(`Translation failed: ${(await apiResp.text()).slice(0, 160)}`);
    const translated = JSON.parse((await apiResp.json()).candidates[0].content.parts[0].text).lines || [];
    if (translated.length === 0) throw new Error("Translation returned no lines");

    // Rebuild timed lines with translated text (fall back to original if counts differ)
    const localizedLines = lines.map((l, i) => ({
      text: (translated[i] || l.text),
      startTime: parseFloat(l.startTime) || 0,
      duration: parseFloat(l.duration) || 3
    }));

    console.log(`Localizing to ${lang.name}: translating + synthesizing ${localizedLines.length} lines...`);
    const voiceover = await synthesizeTimedNarration(localizedLines, voice || lang.voice, `voiceover_${langCode}`);

    res.json({
      success: true,
      langCode,
      language: lang.name,
      lines: localizedLines,
      voiceover
    });
  } catch (error) {
    console.error("Localization error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Generate instrumental background music with Lyria 3 via the Interactions API
// Send the prompt to Lyria verbatim. Length and arrangement come from the model
// based on the prompt — we never force a target duration (callers post-process if needed).
async function generateMusicLyria(prompt, rawOutPath) {
  const requestBody = {
    model: process.env.LYRIA_MODEL || "lyria-3-pro-preview",
    input: prompt,
    response_format: { type: "audio" }
  };

  const resp = await fetch(INTERACTIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Revision': '2026-05-20'
    },
    body: JSON.stringify(requestBody)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    let errorCode = null;
    try { errorCode = JSON.parse(errText)?.error?.code || null; } catch { /* preserve raw response */ }
    const error = new Error(`Lyria status ${resp.status}: ${errText.slice(0, 200)}`);
    error.code = errorCode;
    error.status = resp.status;
    throw error;
  }

  const data = await resp.json();
  let audioBase64 = null;
  if (data.steps && Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (step.type === 'model_output' && step.content) {
        const audioContent = step.content.find(item => item.type === 'audio' && item.data);
        if (audioContent) {
          audioBase64 = audioContent.data;
          break;
        }
      }
    }
  }
  if (!audioBase64) throw new Error("No audio returned by Lyria");

  await fs.promises.writeFile(rawOutPath, Buffer.from(audioBase64, 'base64'));
}

function originalSongRetryPrompt(prompt) {
  const theme = String(prompt)
    .replace(/(["']).*?\1/g, ' ')
    .replace(/\b(?:song|track|music)\s+(?:called|named|titled)\b[^.;]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
  return `Create a new, family-friendly song using only this general theme: ${theme}. The title, melody, lyrics, hook, rhythm, and arrangement must be entirely original and must not quote, recreate, parody, or closely imitate any existing song or recording. Use newly written verses and a newly written chorus with clear vocal diction.`;
}

// Generate AI background music matched to the video's mood
app.post('/api/generate-music', async (req, res) => {
  const tempFiles = [];
  try {
    const { prompt, durationSeconds = 60 } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Missing music prompt" });
    }

    const dur = Math.max(5, Math.min(600, parseFloat(durationSeconds) || 60));
    const stamp = Date.now();
    let engine = 'lyria-3';

    const rawPath = path.join(outputsDir, `music_raw_${stamp}`);
    const srcWavPath = path.join(outputsDir, `music_src_${stamp}.wav`);

    console.log(`Generating background music (bed will be fit to ${dur}s): "${prompt}"`);

    try {
      // Instrumental intent goes in the prompt; length is handled by looping/trimming
      // the result to the video's duration below (never forced onto Lyria).
      const musicPrompt = /instrumental|no vocals/i.test(prompt) ? prompt : `${prompt}. Instrumental, no vocals.`;
      await generateMusicLyria(musicPrompt, rawPath);
      tempFiles.push(rawPath);
      // Decode whatever container came back; retry as raw PCM if unrecognized
      try {
        await execAsync(`ffmpeg -y -i "${rawPath}" "${srcWavPath}"`);
      } catch (decodeErr) {
        await execAsync(`ffmpeg -y -f s16le -ar 48000 -ac 2 -i "${rawPath}" "${srcWavPath}"`);
      }
      tempFiles.push(srcWavPath);
    } catch (err) {
      console.warn(`Lyria music generation failed (${err.message}) — falling back to local ambient synth`);
      engine = 'synth';
    }

    const musicFilename = `music_${stamp}.m4a`;
    const musicPath = path.join(outputsDir, musicFilename);
    const fadeOutStart = Math.max(0, dur - 4);

    if (engine === 'lyria-3') {
      // Loop/trim the generated track to the exact content duration with gentle fades
      const conformCmd = `ffmpeg -y -stream_loop -1 -i "${srcWavPath}" -t ${dur} -af "afade=t=in:d=2,afade=t=out:st=${fadeOutStart}:d=4" -ar 44100 -c:a aac "${musicPath}"`;
      await execAsync(conformCmd);
    } else {
      // Dependable fallback: a calm procedural ambient pad (soft A-major drone + filtered noise)
      const synthCmd = `ffmpeg -y -f lavfi -i "sine=f=220:d=${dur}" -f lavfi -i "sine=f=277.18:d=${dur}" -f lavfi -i "sine=f=329.63:d=${dur}" -f lavfi -i "anoisesrc=color=brown:d=${dur}:a=0.03" -filter_complex "[0:a]volume=0.22[a0];[1:a]volume=0.13[a1];[2:a]volume=0.10[a2];[3:a]lowpass=f=350[a3];[a0][a1][a2][a3]amix=inputs=4:duration=longest:normalize=0,tremolo=f=0.15:d=0.35,lowpass=f=1400,afade=t=in:d=3,afade=t=out:st=${fadeOutStart}:d=4[aout]" -map "[aout]" -ar 44100 -c:a aac "${musicPath}"`;
      await execAsync(synthCmd);
    }

    const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${musicPath}"`);
    const duration = parseFloat(stdout.trim());

    console.log(`Background music ready: ${musicFilename} (${duration}s, engine: ${engine})`);

    res.json({ success: true, filename: musicFilename, duration: duration, engine: engine });
  } catch (error) {
    console.error("Music generation error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
});

// Generate a complete song (with vocals) from a prompt using Lyria 3
app.post('/api/generate-song', async (req, res) => {
  const tempFiles = [];
  try {
    const { prompt } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Missing song prompt" });
    }

    const stamp = Date.now();

    const rawPath = path.join(outputsDir, `song_raw_${stamp}`);
    const srcWavPath = path.join(outputsDir, `song_src_${stamp}.wav`);
    tempFiles.push(rawPath, srcWavPath);

    console.log(`Generating song with Lyria: "${prompt}"`);

    // Describe the arrangement, not the length — Lyria decides the song's natural duration.
    const songPrompt = `${prompt}. A complete song with clearly sung, worded lyrics — real verses and a memorable chorus with actual words, not humming, oohs, or wordless vocals. Clear vocal diction, vocals prominent in the mix.`;
    let policyAdjusted = false;
    try {
      await generateMusicLyria(songPrompt, rawPath);
    } catch (error) {
      if (error.code !== 'content_blocked') throw error;
      policyAdjusted = true;
      const retryPrompt = originalSongRetryPrompt(prompt);
      console.warn('Lyria blocked the initial song brief; retrying once with an original theme-only brief.');
      await generateMusicLyria(retryPrompt, rawPath);
    }

    try {
      await execAsync(`ffmpeg -y -i "${rawPath}" "${srcWavPath}"`);
    } catch (decodeErr) {
      await execAsync(`ffmpeg -y -f s16le -ar 48000 -ac 2 -i "${rawPath}" "${srcWavPath}"`);
    }

    // Songs are never looped or trimmed mid-vocal — keep whatever length Lyria composed,
    // just add a gentle fade-out at the natural end.
    const { stdout: probeOut } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${srcWavPath}"`);
    const songDur = parseFloat(probeOut.trim());
    const fadeOutStart = Math.max(0, songDur - 2);

    const songFilename = `song_${stamp}.m4a`;
    const songPath = path.join(outputsDir, songFilename);
    await execAsync(`ffmpeg -y -i "${srcWavPath}" -af "afade=t=out:st=${fadeOutStart}:d=2" -ar 44100 -c:a aac "${songPath}"`);

    console.log(`Song ready: ${songFilename} (${songDur}s)`);
    await persistMirror(songFilename);

    res.json({ success: true, filename: songFilename, duration: songDur, policyAdjusted });
  } catch (error) {
    console.error("Song generation error:", error);
    res.status(500).json({ error: `Lyria song generation failed: ${error.message}` });
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
});

// Transcribe sung lyrics with line-level timestamps using the configured Gemini text model
app.post('/api/transcribe-lyrics', async (req, res) => {
  try {
    const { audioFilename } = req.body;

    const safeAudioFilename = sanitizeFilename(audioFilename);
    if (!safeAudioFilename) {
      return res.status(400).json({ error: "Invalid audio filename" });
    }
    const audioPath = path.join(outputsDir, safeAudioFilename);
    if (!fs.existsSync(audioPath)) {
      return res.status(400).json({ error: "Audio file not found" });
    }

    const audioBuffer = await fs.promises.readFile(audioPath);
    const ext = path.extname(safeAudioFilename).toLowerCase();
    const mimeType = ext === '.wav' ? 'audio/wav' : (ext === '.m4a' ? 'audio/mp4' : 'audio/mp3');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const systemPrompt = `
Listen carefully to the attached song.
Transcribe the sung lyrics as separate lines (one natural sung phrase per line).
For every line, report the exact time the line STARTS being sung and the time it ENDS,
in seconds from the beginning of the audio (decimal numbers, e.g. 12.5).
Lines must be in chronological order and must not overlap.
If a section has no vocals (intro/instrumental), simply skip it.

Generate the output conforming to the response schema.
`;

    const requestBody = {
      contents: [{
        parts: [
          { inlineData: { mimeType: mimeType, data: audioBuffer.toString('base64') } },
          { text: systemPrompt }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            lines: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  text: { type: "STRING" },
                  startSec: { type: "NUMBER" },
                  endSec: { type: "NUMBER" }
                },
                required: ["text", "startSec", "endSec"]
              }
            }
          },
          required: ["lines"]
        }
      }
    };

    console.log(`Transcribing timed lyrics from ${safeAudioFilename}...`);

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Gemini transcription failed: ${errorText.slice(0, 200)}`);
    }

    const data = await apiResponse.json();
    const parsed = JSON.parse(data.candidates[0].content.parts[0].text);
    const lines = (parsed.lines || []).filter(l => l.text && l.text.trim());

    console.log(`Transcribed ${lines.length} timed lyric lines`);

    res.json({ success: true, lines: lines });
  } catch (error) {
    console.error("Lyrics transcription error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Generate Standalone Title Card (Intro / Outro)
app.post('/api/generate-title-card', async (req, res) => {
  try {
    const { title, subtitle, duration = 4, type = 'intro' } = req.body;
    if (!String(title || '').trim() || !String(subtitle || '').trim()) {
      return res.status(400).json({ error: 'Contextual title-card copy is required' });
    }
    const safeDuration = Math.max(1, parseFloat(duration) || 4);
    
    const bgColor = type === 'intro' ? '0x0d0f1a' : '0x150d1a';
    const accentColor = type === 'intro' ? '0x7c3aed' : '0xec4899';
    
    const titleText = String(title).replace(/'/g, "'\\\\''");
    const subText = String(subtitle).replace(/'/g, "'\\\\''");

    const filename = `card_${type}_${Date.now()}.mp4`;
    const outputPath = path.join(outputsDir, filename);
    const enc = getHardwareVideoEncoder();

    let cmd;
    if (ffmpegHasDrawtext) {
      const drawTextFilter = `drawtext=text='${titleText}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2-40:font='Arial',drawtext=text='${subText}':fontcolor=${accentColor}:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2+30:font='Arial'`;
      cmd = `ffmpeg -y -f lavfi -i color=c=${bgColor}:s=1280x720:d=${safeDuration}:r=30 -vf "${drawTextFilter}" ${enc} -pix_fmt yuv420p "${outputPath}"`;
    } else {
      console.warn('⚠️  Rendering title card WITHOUT text (drawtext unavailable)');
      cmd = `ffmpeg -y -f lavfi -i color=c=${bgColor}:s=1280x720:d=${safeDuration}:r=30 ${enc} -pix_fmt yuv420p "${outputPath}"`;
    }

    console.log(`Generating ${type} title card: ${cmd}`);
    await execAsync(cmd);

    res.json({
      success: true,
      videoUrl: `/outputs/${filename}`,
      filename: filename
    });
  } catch (error) {
    console.error("Error generating title card:", error);
    res.status(500).json({ error: error.message });
  }
});

// Write a card image (base64 data URL) to a temp file for ffmpeg compositing
async function writeCardImage(imageBase64, namePrefix, tempFiles) {
  if (!imageBase64) return null;
  const mimeMatch = imageBase64.match(/^data:image\/(\w+);base64,/);
  const ext = mimeMatch ? (mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1]) : 'jpg';
  const clean = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const imgPath = path.join(outputsDir, `${namePrefix}_${Date.now()}.${ext}`);
  await fs.promises.writeFile(imgPath, Buffer.from(clean, 'base64'));
  tempFiles.push(imgPath);
  return imgPath;
}

// Build the ffmpeg command for a title card, optionally compositing an image above the text
// Resolve a card's image: a server-side file (AI-generated) or inline base64 (upload)
async function resolveCardImage(card, namePrefix, tempFiles) {
  if (card && card.imageFilename) {
    const safe = sanitizeFilename(card.imageFilename);
    const p = safe && path.join(outputsDir, safe);
    if (p && fs.existsSync(p)) return p;
  }
  return writeCardImage(card ? card.imageBase64 : null, namePrefix, tempFiles);
}

// YouTube-style subscribe pill drawn with ffmpeg (red box + "▶ SUBSCRIBE")
function subscribeDraw(w, h, centerY) {
  const bw = Math.round(w * 0.24);
  const bh = Math.max(40, Math.round(h * 0.075));
  const bx = Math.round((w - bw) / 2);
  const by = Math.round(centerY - bh / 2);
  const fsz = Math.round(bh * 0.44);
  return `,drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=0xFF0000@1:t=fill` +
         `,drawtext=text='SUBSCRIBE':fontcolor=white:fontsize=${fsz}:x=(w-text_w)/2:y=${by}+(${bh}-text_h)/2`;
}

function escapeXml(value) {
  return String(value || '').replace(/[<>&"']/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[char]);
}

function wrapCardText(value, maxChars, maxLines = 2) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const current = lines[lines.length - 1];
    if (!current || current.length + word.length + 1 > maxChars) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  if (lines.length > maxLines) {
    lines[maxLines - 1] = lines.slice(maxLines - 1).join(' ');
    lines.length = maxLines;
  }
  return lines;
}

async function createCardTextOverlay({ title, subtitle, subColor, orientation, namePrefix, tempFiles }) {
  if (!String(title || '').trim() && !String(subtitle || '').trim()) return null;
  const { w, h } = getOutputDims(orientation);
  const vertical = orientation === 'vertical';
  const titleLines = wrapCardText(title, vertical ? 20 : 34);
  const subtitleLines = wrapCardText(subtitle, vertical ? 26 : 52);
  const titleSize = Math.round(h * (vertical ? 0.048 : 0.072));
  const subtitleSize = Math.round(h * (vertical ? 0.024 : 0.036));
  const titleGap = Math.round(titleSize * 1.12);
  const subtitleGap = Math.round(subtitleSize * 1.2);
  const blockTop = Math.round(h * 0.55);
  let y = blockTop + Math.round(h * 0.1);
  const titleSvg = titleLines.map(line => {
    const text = `<text x="${w / 2}" y="${y}" text-anchor="middle" fill="white" stroke="black" stroke-opacity="0.75" stroke-width="${Math.max(3, Math.round(titleSize * 0.06))}" paint-order="stroke" font-family="Arial, Helvetica, sans-serif" font-size="${titleSize}" font-weight="800">${escapeXml(line)}</text>`;
    y += titleGap;
    return text;
  }).join('');
  y += Math.round(h * 0.015);
  const subtitleSvg = subtitleLines.map(line => {
    const text = `<text x="${w / 2}" y="${y}" text-anchor="middle" fill="#${subColor.replace(/^0x/, '')}" stroke="black" stroke-opacity="0.8" stroke-width="${Math.max(2, Math.round(subtitleSize * 0.07))}" paint-order="stroke" font-family="Arial, Helvetica, sans-serif" font-size="${subtitleSize}" font-weight="700">${escapeXml(line)}</text>`;
    y += subtitleGap;
    return text;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="0" y="${blockTop}" width="${w}" height="${h - blockTop}" fill="black" fill-opacity="0.5"/>${titleSvg}${subtitleSvg}</svg>`;
  const overlayPath = path.join(outputsDir, `${namePrefix}_${Date.now()}.png`);
  await sharp(Buffer.from(svg)).png().toFile(overlayPath);
  tempFiles.push(overlayPath);
  return overlayPath;
}

// Write display text to a temp file so drawtext can read it via textfile=.
// This is bulletproof: NO filtergraph escaping is needed for ANY punctuation
// (colons, apostrophes, quotes, %, commas, brackets) or even emoji — which is
// what repeatedly broke inline text='…' title cards.
function writeDrawtextFile(text, tag, tempFiles) {
  const clean = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return null;
  const p = path.join(outputsDir, `cardtext_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
  fs.writeFileSync(p, clean);
  if (tempFiles) tempFiles.push(p);
  return p;
}

// Build the ffmpeg command for a title card.
// imageMode 'background' → full-bleed cover art + scrim + lower-third text
// (+ optional Ken Burns slow zoom and subscribe pill). 'badge' → small image above text.
function buildTitleCardCmd({ bgColor, imgPath, textOverlayPath, imageMode = 'badge', kenBurns = false, subscribe = false,
                             title, subtitle, subColor, duration, outPath, orientation = 'landscape', tempFiles = [] }) {
  const enc = getHardwareVideoEncoder();
  const { w, h } = getOutputDims(orientation);
  const size = `${w}x${h}`;
  const frames = Math.max(1, Math.round(duration * 30));

  // Titles/subtitles come from AI (arbitrary punctuation) — render them via textfile
  const titleFile = writeDrawtextFile(title, 'title', tempFiles);
  const subFile = writeDrawtextFile(subtitle, 'sub', tempFiles);
  const safeTitle = titleFile; // truthy when there is title text (used by hasText checks)
  const safeSub = subFile;
  const dtTitle = (opts) => titleFile ? `drawtext=textfile='${titleFile}':expansion=none:${opts}` : '';
  const dtSub = (opts) => subFile ? `drawtext=textfile='${subFile}':expansion=none:${opts}` : '';

  // Fallback: Sharp provides exact text as a transparent image when drawtext is unavailable.
  if (!ffmpegHasDrawtext) {
    if (imgPath && imageMode === 'background') {
      const fill = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
      const kb = kenBurns
        ? `,zoompan=z='min(1+0.0010*in,1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${size}:fps=30`
        : '';
      if (textOverlayPath) {
        return `ffmpeg -y -loop 1 -framerate 30 -t ${duration} -i "${imgPath}" -loop 1 -framerate 30 -t ${duration} -i "${textOverlayPath}" -filter_complex "[0:v]${fill}${kb}[bg];[1:v]format=rgba[text];[bg][text]overlay=0:0" -frames:v ${frames} ${enc} -pix_fmt yuv420p "${outPath}"`;
      }
      return `ffmpeg -y -loop 1 -framerate 30 -t ${duration} -i "${imgPath}" -vf "${fill}${kb}" -frames:v ${frames} ${enc} -pix_fmt yuv420p "${outPath}"`;
    }
    if (imgPath) {
      const imgScale = orientation === 'vertical' ? '640:640' : '900:360';
      const imgY = Math.round(h * 0.22);
      const textInput = textOverlayPath ? ` -loop 1 -framerate 30 -t ${duration} -i "${textOverlayPath}"` : '';
      const textFilter = textOverlayPath ? ';[base][2:v]overlay=0:0[out]' : '';
      const output = textOverlayPath ? '[out]' : '[base]';
      return `ffmpeg -y -f lavfi -i color=c=${bgColor}:s=${size}:d=${duration}:r=30 -i "${imgPath}"${textInput} -filter_complex "[1:v]scale=${imgScale}:force_original_aspect_ratio=decrease[img];[0:v][img]overlay=(W-w)/2:${imgY}[base]${textFilter}" -map "${output}" ${enc} -pix_fmt yuv420p "${outPath}"`;
    }
    if (textOverlayPath) return `ffmpeg -y -f lavfi -i color=c=${bgColor}:s=${size}:d=${duration}:r=30 -loop 1 -framerate 30 -t ${duration} -i "${textOverlayPath}" -filter_complex "[0:v][1:v]overlay=0:0" -frames:v ${frames} ${enc} -pix_fmt yuv420p "${outPath}"`;
    return `ffmpeg -y -f lavfi -i color=c=${bgColor}:s=${size}:d=${duration}:r=30 ${enc} -pix_fmt yuv420p "${outPath}"`;
  }

  if (imgPath && imageMode === 'background') {
    // Full-bleed cover: fill frame, optional slow zoom, darkened lower third, text + pill
    const fill = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    const kb = kenBurns
      ? `,zoompan=z='min(1+0.0010*in,1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${size}:fps=30`
      : '';
    const hasText = !!(safeTitle || safeSub || subscribe);
    const scrimY = Math.round(h * 0.55);
    const scrim = hasText ? `,drawbox=x=0:y=${scrimY}:w=${w}:h=${h - scrimY}:color=black@0.45:t=fill` : '';
    const titleY = Math.round(h * 0.62);
    const subY = titleY + Math.round(h * 0.11);
    let draw = '';
    const t1 = dtTitle(`fontcolor=white:fontsize=${Math.round(h * 0.075)}:x=(w-text_w)/2:y=${titleY}:borderw=4:bordercolor=black@0.6`);
    const s1 = dtSub(`fontcolor=${subColor}:fontsize=${Math.round(h * 0.038)}:x=(w-text_w)/2:y=${subY}:borderw=3:bordercolor=black@0.6`);
    if (t1) draw += ',' + t1;
    if (s1) draw += ',' + s1;
    if (subscribe) draw += subscribeDraw(w, h, Math.round(h * 0.875));
    return `ffmpeg -y -loop 1 -framerate 30 -t ${duration} -i "${imgPath}" -vf "${fill}${kb}${scrim}${draw}" -frames:v ${frames} ${enc} -pix_fmt yuv420p "${outPath}"`;
  }

  // Base canvas: a slow animated gradient (when available) beats a flat color
  const base = ffmpegHasGradients
    ? `gradients=s=${size}:c0=${bgColor}:c1=0x1e1b4b:x0=0:y0=0:x1=${w}:y1=${h}:d=${duration}:speed=0.03`
    : `color=c=${bgColor}:s=${size}:d=${duration}:r=30`;

  if (imgPath) {
    // Badge layout: image centered in the upper area, text below
    const imgScale = orientation === 'vertical' ? '640:640' : '900:360';
    const imgY = Math.round(h * 0.12);
    const titleY = Math.round(h * 0.68);
    const subY = Math.round(h * 0.78);
    let draw = '';
    const t2 = dtTitle(`fontcolor=white:fontsize=44:x=(w-text_w)/2:y=${titleY}:borderw=3:bordercolor=black@0.6`);
    const s2 = dtSub(`fontcolor=${subColor}:fontsize=24:x=(w-text_w)/2:y=${subY}:borderw=2:bordercolor=black@0.6`);
    if (t2) draw += ',' + t2;
    if (s2) draw += ',' + s2;
    if (subscribe) draw += subscribeDraw(w, h, Math.round(h * 0.90));
    return `ffmpeg -y -f lavfi -i "${base}" -i "${imgPath}" -filter_complex "[1:v]scale=${imgScale}:force_original_aspect_ratio=decrease[img];[0:v][img]overlay=(W-w)/2:${imgY}${draw}" -frames:v ${frames} ${enc} -pix_fmt yuv420p "${outPath}"`;
  }

  let draw = '';
  const t3 = dtTitle(`fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2-40:borderw=3:bordercolor=black@0.6`);
  const s3 = dtSub(`fontcolor=${subColor}:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2+30:borderw=2:bordercolor=black@0.6`);
  draw = [t3, s3].filter(Boolean).join(',');
  if (subscribe) draw += (draw ? ',' : '') + subscribeDraw(w, h, Math.round(h * 0.82));
  return `ffmpeg -y -f lavfi -i "${base}" ${draw ? `-vf "${draw}"` : ''} ${enc} -pix_fmt yuv420p "${outPath}"`;
}


// Continuity agent: review scene prompts for coherence as a sequence
app.post('/api/review-coherence', async (req, res) => {
  try {
    const { scenes, characterName, topic, style } = req.body;

    if (!scenes || !Array.isArray(scenes) || scenes.length < 2) {
      return res.status(400).json({ error: "Need at least 2 scenes to review coherence" });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const sceneList = scenes.map((s, i) =>
      `Scene ${i + 1} [newBackground=${s.newBackground !== false}]${s.narration ? ` (narration: "${s.narration}")` : ''}: ${s.prompt}`
    ).join('\n');

    const contextLine = characterName
      ? `All scenes feature the same character: "${characterName}".`
      : (topic ? `The video explains: "${topic}".` : '');

    const systemPrompt = `
You are a continuity supervisor reviewing scene prompts for an AI video generator.
The scenes will be generated independently, so each prompt must carry the shared context itself.

Scenes in order:
${sceneList}

${contextLine}
${style ? `Intended visual style: "${style}".` : ''}

Check the sequence for:
1. Visual style consistency — every prompt should state the same style wording.
2. Subject/character consistency — no contradictory descriptions (colors, outfits, species) across scenes.
3. Setting continuity — a scene with newBackground=false continues the PREVIOUS scene's location, so both prompts must describe that location consistently.
4. Narrative flow — each scene should follow logically from the previous one and match its narration line if provided.
5. Accidental near-duplicates between scenes.

For EVERY scene return:
- "sceneNumber": its 1-based number as listed above.
- "coherent": true if the prompt needs no changes.
- "issue": a short description of the problem ("" if coherent).
- "revisedPrompt": an improved prompt that fixes the issues while preserving the scene's intent,
  style and subject. If coherent, return the original prompt unchanged.
Also return "overallAssessment": 1-2 sentences on the sequence as a whole.

Generate the output conforming to the response schema.
`;

    const requestBody = {
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            overallAssessment: { type: "STRING" },
            scenes: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  sceneNumber: { type: "NUMBER" },
                  coherent: { type: "BOOLEAN" },
                  issue: { type: "STRING" },
                  revisedPrompt: { type: "STRING" }
                },
                required: ["sceneNumber", "coherent", "issue", "revisedPrompt"]
              }
            }
          },
          required: ["overallAssessment", "scenes"]
        }
      }
    };

    console.log(`Continuity agent reviewing ${scenes.length} scene prompts...`);

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Gemini coherence review failed: ${errorText.slice(0, 200)}`);
    }

    const data = await apiResponse.json();
    const parsed = JSON.parse(data.candidates[0].content.parts[0].text);
    const flagged = (parsed.scenes || []).filter(s => !s.coherent).length;

    console.log(`Continuity review done: ${flagged}/${scenes.length} scenes flagged`);

    res.json(parsed);
  } catch (error) {
    console.error("Coherence review error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Video realism agent: watch a GENERATED clip and flag real-world implausibility
app.post('/api/review-video-realism', async (req, res) => {
  const tempFiles = [];
  try {
    const { filename, prompt } = req.body;

    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename) return res.status(400).json({ error: "Invalid scene filename" });
    const inputPath = path.join(outputsDir, safeFilename);
    if (!fs.existsSync(inputPath)) return res.status(400).json({ error: "Scene video not found" });

    // Downscale to a compact clip so it fits in an inline Gemini request (<20MB)
    const smallPath = path.join(outputsDir, `realism_${Date.now()}.mp4`);
    tempFiles.push(smallPath);
    await execAsync(`ffmpeg -y -i "${inputPath}" -t 10 -vf "scale=-2:360,fps=6" -an -c:v libx264 -crf 30 -preset veryfast -pix_fmt yuv420p "${smallPath}"`);

    const videoBuffer = await fs.promises.readFile(smallPath);
    const videoBase64 = videoBuffer.toString('base64');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const systemPrompt = `
You are a VFX and physics continuity supervisor reviewing an AI-generated video clip.
The clip was generated from this prompt: "${prompt || 'unknown'}".

Watch the clip and judge its REAL-WORLD PLAUSIBILITY. Look specifically for:
- Impossible or broken motion (things drifting, sliding, teleporting, moving against physics).
- Objects in implausible places or at wrong scale (e.g. a laptop floating, a boat on land, a person clipping through furniture).
- Anatomy/pose problems (extra or fused limbs, hands merging, unnatural body bending).
- Objects morphing, appearing or vanishing unnaturally between moments.
- Perspective, gravity, lighting or reflection that contradicts the real world.
Ignore artistic style choices (claymation, cartoon, etc.) — judge plausibility WITHIN that style.

Return:
- "realismScore": integer 1-10 (10 = fully plausible, natural motion and placement).
- "coherent": true if the clip is acceptable (score >= 7 and no serious break).
- "issues": array of short, specific problems you actually see ([] if none).
- "suggestedFix": a short clause to APPEND to the original prompt to fix the biggest issue on
  regeneration (e.g. "keep the laptop resting flat on the desk, hands typing naturally"). "" if coherent.
- "summary": one sentence overall verdict.

Generate the output conforming to the response schema.
`;

    const requestBody = {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'video/mp4', data: videoBase64 } },
          { text: systemPrompt }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            realismScore: { type: "NUMBER" },
            coherent: { type: "BOOLEAN" },
            issues: { type: "ARRAY", items: { type: "STRING" } },
            suggestedFix: { type: "STRING" },
            summary: { type: "STRING" }
          },
          required: ["realismScore", "coherent", "issues", "suggestedFix", "summary"]
        }
      }
    };

    console.log(`Video realism agent reviewing ${safeFilename}...`);

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Gemini video review failed: ${errorText.slice(0, 200)}`);
    }

    const data = await apiResponse.json();
    const parsed = JSON.parse(data.candidates[0].content.parts[0].text);

    console.log(`Realism review of ${safeFilename}: score ${parsed.realismScore}, coherent=${parsed.coherent}`);

    res.json(parsed);
  } catch (error) {
    console.error("Video realism review error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
});

/* ==========================================================================
   Content Planner — channels, scheduled videos, and the viral topics agent
   ========================================================================== */

const plannerPath = path.join(__dirname, 'planner.json');

// Full planner data (channels/videos + Trend Watch settings + digest history)
const EMPTY_PLANNER = { channels: [], videos: [], settings: {}, digests: [] };

async function loadPlannerData() {
  // NEWEST copy wins between the local file and Firestore. A stale cloud doc
  // must never silently overwrite fresher local work (and vice versa) — both
  // sides carry a savedAt stamp; the local file falls back to its mtime.
  let local = null;
  let localSavedAt = 0;
  try {
    if (fs.existsSync(plannerPath)) {
      local = JSON.parse(await fs.promises.readFile(plannerPath, 'utf8'));
      localSavedAt = local.savedAt || Math.round(fs.statSync(plannerPath).mtimeMs);
    }
  } catch (err) {
    console.warn("Planner local load failed:", err.message);
  }

  if (cloud.firestoreEnabled) {
    const remote = await loadDoc('planner', 'main');
    const remoteSavedAt = (remote && remote.savedAt) || 0;
    if (remote && (!local || remoteSavedAt >= localSavedAt)) {
      return { ...EMPTY_PLANNER, ...remote };
    }
    if (local && remote && localSavedAt > remoteSavedAt) {
      console.log(`Planner: local copy is newer than Firestore (${new Date(localSavedAt).toISOString()} > ${remoteSavedAt ? new Date(remoteSavedAt).toISOString() : 'unstamped'}) — pushing local up`);
      saveDoc('planner', 'main', { ...local, savedAt: localSavedAt }).catch(() => {});
    }
  }
  return local ? { ...EMPTY_PLANNER, ...local } : { ...EMPTY_PLANNER };
}

async function savePlannerData(data) {
  // Stamp every save so the newest-wins merge above can compare copies
  data.savedAt = Date.now();
  await fs.promises.writeFile(plannerPath, JSON.stringify(data, null, 2));
  if (cloud.firestoreEnabled) await saveDoc('planner', 'main', data);
}

app.get('/api/planner', async (req, res) => {
  try {
    const data = await loadPlannerData();
    res.json({ channels: data.channels, videos: data.videos });
  } catch (error) {
    console.error("Planner load error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/planner', async (req, res) => {
  try {
    const { channels = [], videos = [] } = req.body;
    // Merge: the client owns channels/videos; settings, digests and channel brand
    // kits are server-managed (a stale client must never wipe a brand kit)
    const existing = await loadPlannerData();
    const mergedChannels = channels.map(ch => {
      const prev = existing.channels.find(c => c.id === ch.id);
      return {
        ...ch,
        brandRefs: (prev && prev.brandRefs) || ch.brandRefs || [],
        // logo is server-assigned (upload/AI endpoints) — survive stale clients
        logo: ch.logo !== undefined ? ch.logo : (prev ? prev.logo : null)
      };
    });
    await savePlannerData({ ...existing, channels: mergedChannels, videos });
    // Keep the cloud agent's channel list current (best-effort, non-blocking)
    pushChannelsToRemote({ channels: mergedChannels, videos }).catch(err => console.warn("Channel push to remote failed:", err.message));
    res.json({ success: true });
  } catch (error) {
    console.error("Planner save error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Channel brand kit: store an album cover / character art image per channel.
// Saved as a file in outputs/ (syncs via Cloud Storage) and referenced by filename.
const BRAND_KIT_MAX = 6;

app.post('/api/channel-brand', async (req, res) => {
  try {
    const { channelId, imageBase64, remove = false, removeFile = null } = req.body;
    if (!channelId) return res.status(400).json({ error: "Missing channelId" });

    const data = await loadPlannerData();
    const channel = data.channels.find(c => c.id === channelId);
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    if (remove) {
      channel.brandRefs = [];
      await savePlannerData(data);
      return res.json({ success: true, brandRefs: [] });
    }
    if (removeFile) {
      channel.brandRefs = (channel.brandRefs || []).filter(f => f !== sanitizeFilename(removeFile));
      await savePlannerData(data);
      return res.json({ success: true, brandRefs: channel.brandRefs });
    }

    if (!imageBase64 || !/^data:image\//.test(imageBase64)) {
      return res.status(400).json({ error: "Missing image data" });
    }
    const mimeMatch = imageBase64.match(/^data:image\/(\w+);base64,/);
    const ext = mimeMatch ? (mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1]) : 'jpg';
    const filename = `brand_${channelId}_${Date.now()}.${ext}`;
    const localPath = path.join(outputsDir, filename);
    await fs.promises.writeFile(
      localPath,
      Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    );

    if (cloud.storageEnabled) {
      console.log(`☁️ Uploading brand kit image directly to GCS: ${filename}`);
      await mirrorMedia(localPath);
    }

    // Kits hold several reference images (album cover, character sheets, style art)
    channel.brandRefs = [...(channel.brandRefs || []), filename].slice(-BRAND_KIT_MAX);
    await savePlannerData(data);
    console.log(`Brand kit image added for channel "${channel.name}": ${filename} (${channel.brandRefs.length}/${BRAND_KIT_MAX})`);
    res.json({ success: true, brandRefs: channel.brandRefs, url: `/outputs/${filename}` });
  } catch (error) {
    console.error("Channel brand error:", error);
    res.status(500).json({ error: error.message });
  }
});

// AI brand-kit builder: generates a cohesive set of brand images for a channel —
// key art (cover), a character model sheet, and a scene style frame — conditioned
// on any images already in the kit (or from the name + niche when empty).
const BRAND_KIT_PIECES = [
  {
    tag: 'key art',
    prompt: (name, niche) => `Signature key art / album-cover style image for the ${niche ? `"${niche}" ` : ''}channel "${name}".
Vibrant, instantly recognizable, joyful composition featuring the channel's main character(s).
The channel name "${name}" may appear in bold playful lettering. 16:9 landscape.`
  },
  {
    tag: 'character model sheet',
    prompt: (name, niche) => `Character MODEL SHEET for the main mascot character(s) of the ${niche ? `"${niche}" ` : ''}channel "${name}".
Show the character in 4-5 poses/angles (front, side, back, action pose) on a plain light background,
consistent proportions and outfit in every pose — a reference sheet an animator could work from.`
  },
  {
    tag: 'scene style frame',
    prompt: (name, niche) => `Environment STYLE FRAME for the ${niche ? `"${niche}" ` : ''}channel "${name}":
a typical scene location rendered in the channel's exact art style — colors, lighting and texture
that every video should match. No text, no characters in frame. 16:9 landscape.`
  }
];

app.post('/api/generate-brand-kit', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: "Missing channelId" });

    const data = await loadPlannerData();
    const channel = data.channels.find(c => c.id === channelId);
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    // Existing kit images condition the new pieces so everything stays one style
    const seedParts = [];
    for (const f of (channel.brandRefs || []).slice(0, 2)) {
      const p = path.join(outputsDir, f);
      if (fs.existsSync(p)) {
        const ext = path.extname(f).slice(1).replace('jpg', 'jpeg') || 'png';
        seedParts.push({ inlineData: { mimeType: `image/${ext}`, data: fs.readFileSync(p).toString('base64') } });
      }
    }
    const styleNote = seedParts.length
      ? 'Match the art style, characters and color palette of the attached reference image(s) EXACTLY — same universe, same characters. '
      : '';

    const models = GEMINI_IMAGE_MODELS;
    const created = [];
    for (const piece of BRAND_KIT_PIECES) {
      if ((channel.brandRefs || []).length + created.length >= BRAND_KIT_MAX) break;
      let imageBase64 = null;
      for (const model of models) {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [...seedParts, { text: styleNote + piece.prompt(channel.name, channel.niche || '') }] }],
                generationConfig: { responseModalities: ["IMAGE"] }
              })
            }
          );
          if (!resp.ok) continue;
          const out = await resp.json();
          const imgPart = (out.candidates?.[0]?.content?.parts || []).find(p => p.inlineData && p.inlineData.data);
          if (imgPart) { imageBase64 = imgPart.inlineData.data; break; }
        } catch { /* try next model */ }
      }
      if (!imageBase64) {
        console.warn(`Brand kit piece "${piece.tag}" failed for ${channel.name} — skipping`);
        continue;
      }
      const filename = `brand_${channelId}_${Date.now()}_${created.length}.png`;
      const localPath = path.join(outputsDir, filename);
      await fs.promises.writeFile(localPath, Buffer.from(imageBase64, 'base64'));
      if (cloud.storageEnabled) mirrorMedia(localPath).catch(() => {});
      created.push(filename);
      // The first generated piece also seeds the later ones for internal consistency
      if (seedParts.length < 2) {
        seedParts.push({ inlineData: { mimeType: 'image/png', data: imageBase64 } });
      }
      console.log(`Brand kit piece generated for "${channel.name}": ${piece.tag} → ${filename}`);
    }

    if (created.length === 0) return res.status(500).json({ error: "Brand kit generation produced no images" });

    channel.brandRefs = [...(channel.brandRefs || []), ...created].slice(-BRAND_KIT_MAX);
    await savePlannerData(data);
    res.json({ success: true, created, brandRefs: channel.brandRefs });
  } catch (error) {
    console.error("Brand kit generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Manually upload a rendered master video / audio to GCS
app.post('/api/gcs/upload', async (req, res) => {
  try {
    const { filename } = req.body;
    const safe = sanitizeFilename(filename);
    if (!safe) return res.status(400).json({ error: "Invalid filename" });
    const localPath = path.join(outputsDir, safe);
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({ error: `File not found: ${safe}` });
    }
    if (!cloud.storageEnabled) {
      return res.status(400).json({ error: "Google Cloud Storage is not configured/enabled." });
    }
    console.log(`Manually mirroring file to GCS: ${safe}`);
    const ok = await mirrorMedia(localPath);
    if (!ok) throw new Error("GCS mirror upload failed.");
    res.json({ success: true, message: `Successfully uploaded ${safe} to GCS bucket: gs://${process.env.GCS_BUCKET || ''}` });
  } catch (error) {
    console.error("GCS upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Attach a logo file to a channel record (shared by upload + AI generation)
async function setChannelLogo(channelId, filename) {
  const data = await loadPlannerData();
  const channel = data.channels.find(c => c.id === channelId);
  if (!channel) return null;
  channel.logo = filename;
  await savePlannerData(data);
  if (cloud.storageEnabled) mirrorMedia(path.join(outputsDir, filename)).catch(() => {});
  return channel;
}

// Generate a channel logo with AI: clean badge on pure white, then the white is
// keyed out so the watermark overlays with real transparency.
app.post('/api/generate-logo', async (req, res) => {
  const tempFiles = [];
  try {
    const { channelId, channelName = '', niche = '', referenceImages = [] } = req.body;
    const name = channelName || 'the channel';

    const refs = (Array.isArray(referenceImages) ? referenceImages : [])
      .filter(r => typeof r === 'string' && r.length > 100).slice(0, 3);
    const refBlock = refs.length
      ? `Match the art style, characters and color palette of the attached reference image(s) (the channel's brand art). `
      : '';

    const prompt = `${refBlock}Design a circular logo BADGE for the YouTube channel "${name}"${niche ? ` (${niche})` : ''}.
Flat modern mascot-style badge: bold shapes, 2-4 vibrant colors, instantly readable at small size.
The channel name may appear in short bold text inside the badge if it fits nicely.
The badge must be perfectly centered on a PURE WHITE (#FFFFFF) background with nothing else —
no shadows, no gradients outside the badge, no watermark.`;

    const parts = refs.map(r => ({
      inlineData: {
        mimeType: (r.match(/^data:(image\/\w+);base64,/) || [])[1] || 'image/png',
        data: r.replace(/^data:image\/\w+;base64,/, '')
      }
    }));
    parts.push({ text: prompt });

    const models = GEMINI_IMAGE_MODELS;
    let imageBase64 = null, lastErr = null;
    for (const model of models) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"] } })
          }
        );
        if (!resp.ok) { lastErr = new Error(`${model}: status ${resp.status}`); continue; }
        const data = await resp.json();
        const imgPart = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData && p.inlineData.data);
        if (imgPart) { imageBase64 = imgPart.inlineData.data; break; }
        lastErr = new Error(`${model}: no image in response`);
      } catch (err) { lastErr = err; }
    }
    if (!imageBase64) throw new Error(`Logo generation unavailable: ${lastErr ? lastErr.message : 'unknown'}`);

    const rawPath = path.join(outputsDir, `logo_raw_${Date.now()}.png`);
    tempFiles.push(rawPath);
    await fs.promises.writeFile(rawPath, Buffer.from(imageBase64, 'base64'));

    // Key out the pure-white backdrop → transparent PNG, sized for watermarking
    const logoFilename = `logo_${channelId || 'project'}_${Date.now()}.png`;
    const logoPath = path.join(outputsDir, logoFilename);
    await execAsync(`ffmpeg -y -i "${rawPath}" -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,colorkey=0xFFFFFF:0.08:0.05" "${logoPath}"`);

    if (channelId) await setChannelLogo(channelId, logoFilename);

    console.log(`Channel logo generated: ${logoFilename}${channelId ? ` (attached to channel ${channelId})` : ''}`);
    res.json({ success: true, filename: logoFilename, url: `/outputs/${logoFilename}` });
  } catch (error) {
    console.error("Logo generation error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    tempFiles.forEach(f => fs.unlink(f, () => {}));
  }
});

// Upload a ready-made logo for a channel (PNG with transparency recommended)
app.post('/api/channel-logo', async (req, res) => {
  try {
    const { channelId, imageBase64, remove = false } = req.body;
    if (!channelId) return res.status(400).json({ error: "Missing channelId" });

    if (remove) {
      const data = await loadPlannerData();
      const channel = data.channels.find(c => c.id === channelId);
      if (channel) { channel.logo = null; await savePlannerData(data); }
      return res.json({ success: true, logo: null });
    }

    if (!imageBase64 || !/^data:image\//.test(imageBase64)) {
      return res.status(400).json({ error: "Missing image data" });
    }
    const ext = ((imageBase64.match(/^data:image\/(\w+);base64,/) || [])[1] || 'png').replace('jpeg', 'jpg');
    const filename = `logo_${channelId}_${Date.now()}.${ext}`;
    await fs.promises.writeFile(
      path.join(outputsDir, filename),
      Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    );
    const channel = await setChannelLogo(channelId, filename);
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    console.log(`Logo uploaded for channel "${channel.name}": ${filename}`);
    res.json({ success: true, filename, url: `/outputs/${filename}` });
  } catch (error) {
    console.error("Channel logo error:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- Live trend sources (all best-effort; failures degrade gracefully) ---

// Google Trends "trending now" searches (public RSS feed, no API key)
async function fetchGoogleTrends(geo = 'US') {
  try {
    const resp = await fetch(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    // Only <title> inside <item>; skip the channel title "Daily Search Trends"
    const items = xml.split('<item>').slice(1);
    const titles = items
      .map(chunk => {
        const m = chunk.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
        return m ? m[1].trim() : null;
      })
      .filter(Boolean);
    return titles.slice(0, 15);
  } catch (err) {
    console.warn("Google Trends fetch failed:", err.message);
    return [];
  }
}

// Get a Reddit OAuth token via client-credentials (only if app creds are configured)
async function getRedditToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const auth = Buffer.from(`${id}:${secret}`).toString('base64');
    const resp = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'OmniStudio:content-planner:v1'
      },
      body: 'grant_type=client_credentials'
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.access_token || null;
  } catch {
    return null;
  }
}

// Reddit hot posts for a subreddit. Uses OAuth when configured (reliable from any IP),
// otherwise falls back to the public .json (works from residential IPs, blocked on many datacenters).
async function fetchRedditHot(subreddit) {
  if (!subreddit) return [];
  const clean = subreddit.replace(/^\/?r\//, '').replace(/[^a-zA-Z0-9_]/g, '');
  const token = await getRedditToken();
  const base = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const headers = {
    'User-Agent': 'OmniStudio:content-planner:v1 (by /u/omnistudio)'
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const resp = await fetch(`${base}/r/${clean}/hot.json?limit=12`, { headers });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data?.children || [])
      .map(c => c.data?.title)
      .filter(Boolean)
      .slice(0, 12);
  } catch (err) {
    console.warn("Reddit fetch failed:", err.message);
    return [];
  }
}

// YouTube most-popular titles (requires YouTube Data API v3 enabled)
async function fetchYouTubePopular(regionCode = 'US', categoryId = null) {
  const key = process.env.YOUTUBE_API_KEY || GEMINI_API_KEY;
  try {
    let url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&maxResults=12&regionCode=${regionCode}&key=${key}`;
    if (categoryId) url += `&videoCategoryId=${categoryId}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const t = await resp.text();
      return { titles: [], error: `YouTube API unavailable (${resp.status}). Enable "YouTube Data API v3" and set YOUTUBE_API_KEY. ${t.slice(0, 100)}` };
    }
    const data = await resp.json();
    return { titles: (data.items || []).map(i => i.snippet?.title).filter(Boolean).slice(0, 12), error: null };
  } catch (err) {
    return { titles: [], error: `YouTube API error: ${err.message}` };
  }
}

// Hacker News Top Stories & Ask HN (Official Firebase REST API)
async function fetchHackerNewsTop() {
  try {
    const resp = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!resp.ok) return [];
    const ids = await resp.json();
    const topIds = ids.slice(0, 15);
    
    const items = await Promise.all(
      topIds.map(async id => {
        try {
          const itemResp = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          if (!itemResp.ok) return null;
          const data = await itemResp.json();
          return data && data.title ? { title: data.title, score: data.score || 0, url: data.url || '' } : null;
        } catch { return null; }
      })
    );
    return items.filter(Boolean);
  } catch (err) {
    console.warn("HackerNews fetch failed:", err.message);
    return [];
  }
}

// Wikipedia Daily Most-Read Articles API
async function fetchWikipediaTopRead() {
  try {
    const yesterday = new Date(Date.now() - 86400000);
    const yyyy = yesterday.getUTCFullYear();
    const mm = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(yesterday.getUTCDate()).padStart(2, '0');
    
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${yyyy}/${mm}/${dd}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'OmniStudio-ViralAgent/1.0 (contact@example.com)' }
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const articles = data.items?.[0]?.articles || [];
    
    // Filter out internal wiki pages
    const filtered = articles
      .filter(a => a.article && !a.article.includes(':') && a.article !== 'Main_Page')
      .map(a => ({
        title: a.article.replace(/_/g, ' '),
        views: a.views
      }));
    
    return filtered.slice(0, 15);
  } catch (err) {
    console.warn("Wikipedia Top Read fetch failed:", err.message);
    return [];
  }
}

// Google News RSS Search
async function fetchGoogleNewsRSS(query = 'technology') {
  try {
    const q = encodeURIComponent(query || 'trending');
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    const items = xml.split('<item>').slice(1);
    const headlines = items.map(chunk => {
      const m = chunk.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
      return m ? m[1].replace(/ - [^-]+$/, '').trim() : null;
    }).filter(Boolean);
    return headlines.slice(0, 12);
  } catch (err) {
    console.warn("Google News RSS fetch failed:", err.message);
    return [];
  }
}

// Multi-subreddit trend collector
async function fetchMultiRedditList(subreddits = ['AskReddit', 'explainlikeimfive', 'todayilearned', 'Showerthoughts']) {
  const results = {};
  await Promise.all(
    subreddits.map(async sub => {
      try {
        const posts = await fetchRedditHot(sub);
        results[sub] = posts;
      } catch {
        results[sub] = [];
      }
    })
  );
  return results;
}

// Multi-Source Viral Trend Radar Endpoint
app.post('/api/planner/trends-radar', async (req, res) => {
  try {
    const { subreddits = ['AskReddit', 'explainlikeimfive', 'todayilearned'], geo = 'US', newsQuery = 'technology', youtubeCategoryId } = req.body;

    const [googleTrends, redditData, hackernews, wikipedia, googleNews, youtube] = await Promise.all([
      fetchGoogleTrends(geo),
      fetchMultiRedditList(subreddits),
      fetchHackerNewsTop(),
      fetchWikipediaTopRead(),
      fetchGoogleNewsRSS(newsQuery),
      fetchYouTubePopular(geo, youtubeCategoryId)
    ]);

    // Perform cross-platform fusion analysis using the configured Gemini text model
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const signalText = `
1. GOOGLE SEARCH TRENDS (Today):
${googleTrends.map(t => `- ${t}`).join('\n')}

2. REDDIT TOP THREADS BY SUBREDDIT:
${Object.entries(redditData).map(([sub, posts]) => `r/${sub}:\n` + posts.map(p => `  • ${p}`).join('\n')).join('\n')}

3. HACKER NEWS TOP STORIES:
${hackernews.map(h => `- ${h.title} (score: ${h.score})`).join('\n')}

4. WIKIPEDIA MOST-READ ARTICLES (Daily):
${wikipedia.map(w => `- ${w.title} (${w.views.toLocaleString()} views)`).join('\n')}

5. GOOGLE NEWS HEADLINES ("${newsQuery}"):
${googleNews.map(n => `- ${n}`).join('\n')}

6. YOUTUBE MOST POPULAR VIDEOS:
${(youtube.titles || []).map(y => `- ${y}`).join('\n')}
`;

    const systemPrompt = `
You are an elite Viral Video Research Agent.
Analyze the multi-source trend signals below and identify CROSS-PLATFORM CONVERGENCES (topics that appear on 2 or more platforms simultaneously, or high-curiosity questions with massive engagement).

${signalText}

Suggest 5 viral video topics based on these live trend signals.

For each topic return a COMPLETE content brief (enough to generate the full video, not just a title):
- "title": CTR-optimized YouTube title under 60 chars.
- "topic": one-sentence core concept.
- "sources": array of provenance tags showing where this trend comes from (e.g. ["Reddit r/explainlikeimfive", "Google Trends", "HackerNews"]).
- "viralScore": estimated viral potential score from 1 to 100 based on cross-platform signal strength.
- "hook": scroll-stopping opening 3-second hook line (this becomes the video's Scene 1).
- "angle": the specific unique angle/framing that makes THIS take stand out from generic coverage.
- "keyPoints": array of 4-6 concrete talking points/beats the video must cover, in narrative order.
  These are the actual content — specific facts, steps, or reveals, NOT vague topics.
- "targetAudience": who this is for and their knowledge level (e.g. "curious beginners, no jargon").
- "format": "long" (60-120s explainer) or "short" (15-60s YouTube Short/Reel).
- "suggestedDurationSeconds": integer, realistic length for the content (30, 60, 90, or 120).
- "videoPrompt": ready-to-paste one-line prompt describing the video for an AI generator.
- "whyViral": concise explanation of why this topic is blowing up right now.

Also return "crossPlatformSummary": 2 sentences summarizing today's key trend overlaps.

Generate output conforming to response schema.
`;

    const requestBody = {
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            crossPlatformSummary: { type: "STRING" },
            topics: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  title: { type: "STRING" },
                  topic: { type: "STRING" },
                  sources: { type: "ARRAY", items: { type: "STRING" } },
                  viralScore: { type: "NUMBER" },
                  hook: { type: "STRING" },
                  angle: { type: "STRING" },
                  keyPoints: { type: "ARRAY", items: { type: "STRING" } },
                  targetAudience: { type: "STRING" },
                  format: { type: "STRING" },
                  suggestedDurationSeconds: { type: "NUMBER" },
                  videoPrompt: { type: "STRING" },
                  whyViral: { type: "STRING" }
                },
                required: ["title", "topic", "sources", "viralScore", "hook", "angle", "keyPoints", "targetAudience", "format", "suggestedDurationSeconds", "videoPrompt", "whyViral"]
              }
            }
          },
          required: ["crossPlatformSummary", "topics"]
        }
      }
    };

    console.log("Viral Trend Radar: Analyzing multi-source signals with Gemini...");

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    let fusionAnalysis = null;
    if (apiResponse.ok) {
      const data = await apiResponse.json();
      fusionAnalysis = JSON.parse(data.candidates[0].content.parts[0].text);
    }

    res.json({
      googleTrends,
      reddit: redditData,
      hackernews,
      wikipedia,
      googleNews,
      youtube: youtube.titles,
      youtubeError: youtube.error,
      fusion: fusionAnalysis
    });

  } catch (error) {
    console.error("Trends Radar error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Aggregate trend signals from all wired sources
app.post('/api/planner/trends', async (req, res) => {

  try {
    const { subreddit, geo = 'US', youtubeCategoryId } = req.body;
    const [googleTrends, reddit, youtube] = await Promise.all([
      fetchGoogleTrends(geo),
      fetchRedditHot(subreddit),
      fetchYouTubePopular(geo, youtubeCategoryId)
    ]);
    res.json({ googleTrends, reddit, youtube: youtube.titles, youtubeError: youtube.error });
  } catch (error) {
    console.error("Trends aggregation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Viral topics agent: suggest video ideas for a channel's niche and platform
// Real performance stats for published videos (public data, YouTube Data API)
app.post('/api/planner/stats', async (req, res) => {
  try {
    const { videoIds = [] } = req.body;
    const ids = videoIds.filter(id => /^[A-Za-z0-9_-]{6,20}$/.test(id)).slice(0, 50);
    if (ids.length === 0) return res.json({ stats: {} });

    const key = process.env.YOUTUBE_API_KEY || GEMINI_API_KEY;
    const resp = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.join(',')}&key=${key}`
    );
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`YouTube API ${resp.status}: ${t.slice(0, 120)}`);
    }
    const data = await resp.json();
    const stats = {};
    (data.items || []).forEach(item => {
      stats[item.id] = {
        views: parseInt(item.statistics?.viewCount || '0', 10),
        likes: parseInt(item.statistics?.likeCount || '0', 10),
        comments: parseInt(item.statistics?.commentCount || '0', 10)
      };
    });
    console.log(`Fetched YouTube stats for ${Object.keys(stats).length}/${ids.length} video(s)`);
    res.json({ stats });
  } catch (error) {
    console.error("Stats fetch error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Core viral-ideas agent — shared by the API endpoint and the Trend Watch scheduler
async function suggestIdeasForChannel({ channelName, platform = 'youtube', niche, count = 5, existingTitles = [], subreddit, geo = 'US', useTrends = false } = {}) {
    if (!niche || !niche.trim()) {
      throw new Error("Channel niche is required for suggestions");
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    // Optionally pull live trend signals to ground the suggestions
    let trendsBlock = '';
    let trendsUsed = { googleTrends: [], reddit: [], youtube: [], youtubeError: null };
    if (useTrends) {
      const [googleTrends, reddit, youtube] = await Promise.all([
        fetchGoogleTrends(geo),
        fetchRedditHot(subreddit),
        fetchYouTubePopular(geo, platform === 'youtube' ? null : null)
      ]);
      trendsUsed = { googleTrends, reddit, youtube: youtube.titles, youtubeError: youtube.error };
      const parts = [];
      if (googleTrends.length) parts.push(`Google Trends (today): ${googleTrends.join('; ')}`);
      if (youtube.titles.length) parts.push(`YouTube most popular now: ${youtube.titles.join('; ')}`);
      if (reddit.length) parts.push(`Reddit r/${(subreddit||'').replace(/^\/?r\//,'')} hot posts: ${reddit.join('; ')}`);
      if (parts.length) {
        trendsBlock = `\nLIVE TREND SIGNALS (only trend-jack where it authentically fits the niche; never force an unrelated trend):\n${parts.join('\n')}\n`;
      }
    }

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
- Pick one core idea and apply an honest angle twist based on contrast, mystery, unexpected change, personal tension, or urgency.
- The title promises the reward; the future thumbnail should add a different visual question, never repeat the title.
- The hook is the first spoken line plus the first visual action. It must work with no greeting or context and be understandable immediately.
- Structure the key points as Hook/Problem → escalating Value/Solution → concrete Payoff/CTA bridge.
- Keep language simple, clear, and relatable. Plan visible demonstrations and progression, not static explanation.
- For long-form, favor one exceptional anchor concept capable of feeding several hook-led Shorts. For short-form, optimize one compact idea for completion and sharing.

For each idea return:
- "title": CTR-optimized title (under 60 chars).
- "topic": one-sentence description of the video content.
- "format": "long", "short", or "reel" (fit the platform).
- "hook": the exact first spoken line plus the simultaneous first visual action that stops the scroll.
- "angle": the unique framing that differentiates this video from generic takes on the topic.
- "keyPoints": 3-5 concrete visual-story beats in order: problem, escalation/evidence, solution,
  payoff, and where appropriate a bridge to the next related video or viewer action.
- "targetAudience": one phrase describing exactly who this is for (age, interest, intent).
- "whyViral": one sentence on why this can perform (search volume, trend, emotion, shareability).
- "videoPrompt": a ready-to-paste prompt describing the hook shot, visual progression, pattern interrupts,
  final payoff, format/orientation, and consistent visual style.
- "bestPostTime": day + time suggestion for this audience.
- "hashtags": 3-5 hashtags.
- "roiPotential": "high", "medium" or "low" — expected payoff relative to production effort.
- "roiEstimatedViews": realistic first-30-days view range for a SMALL/NEW channel in this niche
  (e.g. "2K–15K views"). Be conservative, not hype.
- "roiEstimatedRevenue": rough ad-revenue range for those views at this niche's typical RPM,
  noting the basis (e.g. "$4–$30 at ~$2 RPM"; kids content ≈ $0.5–1 RPM; finance ≈ $8–15 RPM;
  Shorts/Reels ≈ $0.05–0.1 RPM). If the format is a Short/Reel, say the value is mainly
  channel growth, not direct revenue.
- "roiRationale": one sentence on why this ROI: demand vs competition vs production effort
  (number of scenes / regenerations needed).
Also return "strategyNote": 1-2 sentences on the overall content strategy for this channel right now.
These ROI figures are honest speculative estimates to compare ideas against each other,
not guarantees — keep them grounded in typical niche RPMs and small-channel reach.

Generate the output conforming to the response schema.
`;

    const requestBody = {
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            strategyNote: { type: "STRING" },
            ideas: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  title: { type: "STRING" },
                  topic: { type: "STRING" },
                  format: { type: "STRING" },
                  hook: { type: "STRING" },
                  angle: { type: "STRING" },
                  keyPoints: { type: "ARRAY", items: { type: "STRING" } },
                  targetAudience: { type: "STRING" },
                  whyViral: { type: "STRING" },
                  videoPrompt: { type: "STRING" },
                  bestPostTime: { type: "STRING" },
                  hashtags: { type: "ARRAY", items: { type: "STRING" } },
                  roiPotential: { type: "STRING" },
                  roiEstimatedViews: { type: "STRING" },
                  roiEstimatedRevenue: { type: "STRING" },
                  roiRationale: { type: "STRING" }
                },
                required: ["title", "topic", "format", "hook", "angle", "keyPoints", "targetAudience", "whyViral", "videoPrompt", "bestPostTime", "hashtags", "roiPotential", "roiEstimatedViews", "roiEstimatedRevenue", "roiRationale"]
              }
            }
          },
          required: ["strategyNote", "ideas"]
        }
      }
    };

    console.log(`Viral topics agent: suggesting ${count} ideas for "${channelName}" (${platform} / ${niche})`);

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Gemini suggestion failed: ${errorText.slice(0, 200)}`);
    }

    const data = await apiResponse.json();
    const parsed = JSON.parse(data.candidates[0].content.parts[0].text);

    return { ...parsed, trendsUsed };
}

// Viral topics endpoint (thin wrapper over the shared agent core)
app.post('/api/planner/suggest', async (req, res) => {
  try {
    const result = await suggestIdeasForChannel(req.body || {});
    res.json(result);
  } catch (error) {
    console.error("Topic suggestion error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Channel opportunity agent: recommend NEW channel concepts + best platform, from trends
app.post('/api/planner/suggest-channel', async (req, res) => {
  try {
    const { interests = '', geo = 'US', count = 4, existingChannels = [], useTrends = true } = req.body;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    // Pull broad trend signals to ground the niche opportunities
    let trendsBlock = '';
    let trendsUsed = { googleTrends: [], youtube: [], youtubeError: null };
    if (useTrends) {
      const [googleTrends, youtube] = await Promise.all([
        fetchGoogleTrends(geo),
        fetchYouTubePopular(geo, null)
      ]);
      trendsUsed = { googleTrends, youtube: youtube.titles, youtubeError: youtube.error };
      const parts = [];
      if (googleTrends.length) parts.push(`Google Trends (today): ${googleTrends.join('; ')}`);
      if (youtube.titles.length) parts.push(`YouTube most popular now: ${youtube.titles.join('; ')}`);
      if (parts.length) {
        trendsBlock = `\nLIVE TREND SIGNALS to inform demand (use as inspiration for durable niches, not one-off news):\n${parts.join('\n')}\n`;
      }
    }

    const systemPrompt = `
You are a channel strategist for a studio that produces AI-generated videos
(animated explainers, music videos, kids content, cinematic shorts — no real footage,
no real people's likenesses, no live news).
Today's date: ${new Date().toDateString()}.

${interests ? `The creator is interested in: "${interests}".` : 'The creator is open to any profitable niche.'}
${existingChannels.length ? `They already run these channels (suggest DIFFERENT, complementary niches):\n${existingChannels.map(c => `- ${c}`).join('\n')}` : ''}
${trendsBlock}
Propose exactly ${count} distinct channel concepts with strong growth and monetization potential
that AI-generated video can actually produce well.

For each concept return:
- "channelName": a brandable channel name.
- "platform": "youtube" or "instagram" — pick the ONE that best fits this niche's format and audience.
- "platformReason": one sentence on why that platform over the other.
- "niche": a concise niche description (this seeds the video-idea agent later).
- "whyViable": one sentence on audience demand + why it can grow now.
- "monetization": the primary way this channel makes money (ads/RPM, sponsorships, products, etc.).
- "contentPillars": 3-4 recurring content themes/series ideas.
- "exampleTitles": 2-3 example video titles.
- "suggestedSubreddit": one relevant subreddit name (no "r/"), or "" if none fits.
- "postingCadence": realistic posting frequency to grow this channel.
Also return "overallNote": 1-2 sentences comparing the options / where to start first.

Generate the output conforming to the response schema.
`;

    const requestBody = {
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            overallNote: { type: "STRING" },
            channels: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  channelName: { type: "STRING" },
                  platform: { type: "STRING" },
                  platformReason: { type: "STRING" },
                  niche: { type: "STRING" },
                  whyViable: { type: "STRING" },
                  monetization: { type: "STRING" },
                  contentPillars: { type: "ARRAY", items: { type: "STRING" } },
                  exampleTitles: { type: "ARRAY", items: { type: "STRING" } },
                  suggestedSubreddit: { type: "STRING" },
                  postingCadence: { type: "STRING" }
                },
                required: ["channelName", "platform", "platformReason", "niche", "whyViable", "monetization", "contentPillars", "exampleTitles", "suggestedSubreddit", "postingCadence"]
              }
            }
          },
          required: ["overallNote", "channels"]
        }
      }
    };

    console.log(`Channel opportunity agent: suggesting ${count} channel concepts (interests: "${interests}")`);

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`Gemini channel suggestion failed: ${errorText.slice(0, 200)}`);
    }

    const data = await apiResponse.json();
    const parsed = JSON.parse(data.candidates[0].content.parts[0].text);

    res.json({ ...parsed, trendsUsed });
  } catch (error) {
    console.error("Channel suggestion error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ==========================================================================
   Trend Watch — scheduled agent: check trends every N hours, file new ideas,
   and send a digest (email via SMTP if configured + macOS notification)
   ========================================================================== */

let trendWatchTimer = null;
let trendWatchRunning = false;
let trendWatchNextRun = null;

// Remote mode: when TREND_WATCH_REMOTE_URL is set, the agent lives in the cloud
// (see trend-watch-service/). The local app only pushes channels and syncs ideas.
const TREND_WATCH_REMOTE_URL = (process.env.TREND_WATCH_REMOTE_URL || '').replace(/\/$/, '');
const TREND_WATCH_REMOTE_SECRET = process.env.TREND_WATCH_REMOTE_SECRET || '';

async function remoteTrendWatch(apiPath, options = {}) {
  const resp = await fetch(`${TREND_WATCH_REMOTE_URL}${apiPath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-agent-secret': TREND_WATCH_REMOTE_SECRET,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeoutMs || 15000)
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Remote trend-watch ${apiPath} failed (${resp.status}): ${t.slice(0, 150)}`);
  }
  return resp.json();
}

// Push channels (+ titles already in the planner, for dedupe) to the cloud agent
async function pushChannelsToRemote(data) {
  if (!TREND_WATCH_REMOTE_URL) return;
  const channels = data.channels.map(ch => ({
    id: ch.id,
    name: ch.name,
    platform: ch.platform,
    niche: ch.niche,
    subreddit: ch.subreddit || '',
    knownTitles: data.videos.filter(v => v.channelId === ch.id).map(v => v.title).slice(-200)
  }));
  await remoteTrendWatch('/channels', { method: 'PUT', body: JSON.stringify({ channels }) });
}

// Pull pending ideas from the cloud agent into the local planner, then ack them
async function syncIdeasFromRemote() {
  if (!TREND_WATCH_REMOTE_URL) throw new Error("TREND_WATCH_REMOTE_URL is not configured");

  const data = await loadPlannerData();
  await pushChannelsToRemote(data);

  const remote = await remoteTrendWatch('/state');
  const pending = remote.pendingIdeas || [];
  if (pending.length === 0) {
    return { imported: 0, lastRun: remote.lastRun, digests: remote.digests || [] };
  }

  const existingIds = new Set(data.videos.map(v => v.id));
  const existingTitles = new Set(data.videos.map(v => (v.title || '').toLowerCase()));
  const fresh = pending.filter(v => !existingIds.has(v.id) && !existingTitles.has((v.title || '').toLowerCase()));
  data.videos.push(...fresh);

  // Keep the remote digests visible in the local panel too
  const digestIds = new Set((data.digests || []).map(d => d.id));
  (remote.digests || []).forEach(d => { if (!digestIds.has(d.id)) data.digests.unshift(d); });
  data.digests = (data.digests || []).slice(0, 20);
  data.settings.trendWatch = { ...(data.settings.trendWatch || {}), lastRun: remote.lastRun || data.settings.trendWatch?.lastRun };

  await savePlannerData(data);
  await remoteTrendWatch('/ack', { method: 'POST', body: JSON.stringify({ ids: pending.map(v => v.id) }) });

  console.log(`Trend Watch sync: imported ${fresh.length} idea(s) from the cloud agent`);
  return { imported: fresh.length, lastRun: remote.lastRun, digests: remote.digests || [] };
}

function buildDigestHtml(digest) {
  const when = new Date(digest.at).toLocaleString();
  const sections = digest.channels.map(ch => {
    if (ch.error) {
      return `<h3>${ch.channelName}</h3><p style="color:#b45309">Run failed: ${ch.error}</p>`;
    }
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
    <h2>OmniStudio Trend Watch</h2>
    <p>${when} — <strong>${digest.totalNewIdeas} new video ideas</strong> added to your planner.</p>
    ${sections}
    <p style="color:#888;font-size:12px;margin-top:16px;">ROI figures are AI estimates for a new/small channel — for comparing ideas, not guarantees.
    Open the OmniStudio Planner to schedule or generate any of these.</p>
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
      from: SMTP_USER || 'omnistudio@localhost',
      to: DIGEST_EMAIL_TO,
      subject: `OmniStudio Trend Watch: ${digest.totalNewIdeas} new video ideas`,
      html: buildDigestHtml(digest)
    });
    console.log(`Trend Watch digest emailed to ${DIGEST_EMAIL_TO}`);
    return true;
  } catch (err) {
    console.warn("Digest email failed:", err.message);
    return false;
  }
}

// Zero-config fallback: native macOS notification
async function sendDesktopNotification(digest) {
  if (process.platform !== 'darwin' || digest.totalNewIdeas === 0) return false;
  try {
    const msg = `${digest.totalNewIdeas} new video ideas added to your planner`;
    const script = `display notification ${JSON.stringify(msg)} with title "OmniStudio Trend Watch"`;
    await execFileAsync('osascript', ['-e', script]);
    return true;
  } catch {
    return false;
  }
}

async function runTrendWatch(trigger = 'schedule') {
  if (trendWatchRunning) {
    return { ok: false, message: "A Trend Watch run is already in progress" };
  }
  trendWatchRunning = true;

  try {
    const data = await loadPlannerData();
    if (data.channels.length === 0) {
      return { ok: false, message: "No channels in the planner yet — add a channel first" };
    }

    console.log(`Trend Watch run starting (${trigger}) for ${data.channels.length} channel(s)...`);
    const digest = { id: `dg_${Date.now()}`, at: Date.now(), trigger, channels: [], totalNewIdeas: 0, emailed: false, notified: false };

    for (const ch of data.channels) {
      try {
        const existingTitles = data.videos.filter(v => v.channelId === ch.id).map(v => v.title);
        const result = await suggestIdeasForChannel({
          channelName: ch.name,
          platform: ch.platform,
          niche: ch.niche,
          count: 3,
          existingTitles,
          subreddit: ch.subreddit || '',
          useTrends: true
        });

        const newVideos = (result.ideas || [])
          .filter(i => !existingTitles.some(t => t.toLowerCase() === (i.title || '').toLowerCase()))
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

        data.videos.push(...newVideos);
        digest.channels.push({
          channelId: ch.id,
          channelName: ch.name,
          strategyNote: result.strategyNote || '',
          ideas: newVideos.map(v => ({ title: v.title, format: v.format, roi: v.roi, whyViral: v.whyViral }))
        });
        digest.totalNewIdeas += newVideos.length;
      } catch (err) {
        console.warn(`Trend Watch: channel "${ch.name}" failed: ${err.message}`);
        digest.channels.push({ channelId: ch.id, channelName: ch.name, error: err.message, ideas: [] });
      }
    }

    digest.emailed = await sendDigestEmail(digest);
    digest.notified = await sendDesktopNotification(digest);

    data.digests = [digest, ...(data.digests || [])].slice(0, 20);
    data.settings.trendWatch = { ...(data.settings.trendWatch || {}), lastRun: digest.at };
    await savePlannerData(data);

    console.log(`Trend Watch done: ${digest.totalNewIdeas} new ideas (email: ${digest.emailed}, notification: ${digest.notified})`);
    return { ok: true, digest };
  } finally {
    trendWatchRunning = false;
  }
}

async function applyTrendWatchSchedule() {
  if (TREND_WATCH_REMOTE_URL) {
    console.log(`Trend Watch: remote mode → ${TREND_WATCH_REMOTE_URL} (local scheduler off; Cloud Scheduler owns the cadence)`);
    return;
  }
  const data = await loadPlannerData();
  const tw = data.settings.trendWatch || {};

  if (trendWatchTimer) {
    clearInterval(trendWatchTimer);
    trendWatchTimer = null;
    trendWatchNextRun = null;
  }
  if (!tw.enabled) {
    console.log("Trend Watch schedule: disabled");
    return;
  }

  const hours = Math.max(1, Math.min(48, parseFloat(tw.intervalHours) || 5));
  const intervalMs = hours * 3600 * 1000;
  trendWatchNextRun = Date.now() + intervalMs;
  trendWatchTimer = setInterval(() => {
    trendWatchNextRun = Date.now() + intervalMs;
    runTrendWatch('schedule').catch(err => console.error("Scheduled Trend Watch failed:", err));
  }, intervalMs);

  console.log(`Trend Watch scheduled: every ${hours}h (next run ~${new Date(trendWatchNextRun).toLocaleTimeString()})`);
}

app.get('/api/trend-watch', async (req, res) => {
  try {
    const data = await loadPlannerData();
    const tw = data.settings.trendWatch || {};

    if (TREND_WATCH_REMOTE_URL) {
      // Cloud mode: report the remote agent's status (best-effort)
      let remote = null;
      try {
        remote = await remoteTrendWatch('/state', { timeoutMs: 6000 });
      } catch (err) {
        console.warn("Remote trend-watch status unavailable:", err.message);
      }
      return res.json({
        mode: 'remote',
        remoteUrl: TREND_WATCH_REMOTE_URL,
        remoteReachable: !!remote,
        enabled: true,
        intervalHours: null, // owned by Cloud Scheduler
        lastRun: remote ? remote.lastRun : (tw.lastRun || null),
        nextRun: null,
        running: remote ? remote.running : false,
        pendingIdeas: remote ? (remote.pendingIdeas || []).length : null,
        emailConfigured: true, // digests are the cloud service's job
        emailTo: null,
        digests: remote ? (remote.digests || []) : (data.digests || []).slice(0, 5)
      });
    }

    res.json({
      mode: 'local',
      enabled: !!tw.enabled,
      intervalHours: tw.intervalHours || 5,
      lastRun: tw.lastRun || null,
      nextRun: tw.enabled ? trendWatchNextRun : null,
      running: trendWatchRunning,
      emailConfigured: !!(process.env.SMTP_HOST && process.env.DIGEST_EMAIL_TO),
      emailTo: process.env.DIGEST_EMAIL_TO || null,
      digests: (data.digests || []).slice(0, 5)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/trend-watch', async (req, res) => {
  try {
    if (TREND_WATCH_REMOTE_URL) {
      return res.status(400).json({ error: "Cloud mode: the schedule is owned by Cloud Scheduler on Google Cloud, not the local app." });
    }
    const { enabled, intervalHours } = req.body;
    const data = await loadPlannerData();
    data.settings.trendWatch = {
      ...(data.settings.trendWatch || {}),
      enabled: !!enabled,
      intervalHours: Math.max(1, Math.min(48, parseFloat(intervalHours) || 5))
    };
    await savePlannerData(data);
    await applyTrendWatchSchedule();
    res.json({ success: true, ...data.settings.trendWatch, nextRun: trendWatchNextRun });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/trend-watch/run-now', async (req, res) => {
  try {
    if (TREND_WATCH_REMOTE_URL) {
      // Trigger the cloud agent, then pull its results straight into the planner
      await remoteTrendWatch('/run', { method: 'POST', timeoutMs: 240000 });
      const sync = await syncIdeasFromRemote();
      return res.json({ ok: true, mode: 'remote', imported: sync.imported, digest: (sync.digests || [])[0] || { totalNewIdeas: sync.imported, emailed: false } });
    }
    const result = await runTrendWatch('manual');
    if (!result.ok) return res.status(409).json({ error: result.message });
    res.json(result);
  } catch (error) {
    console.error("Manual Trend Watch failed:", error);
    res.status(500).json({ error: error.message });
  }
});

// Cloud mode: pull pending ideas from the remote agent into the planner
app.post('/api/trend-watch/sync', async (req, res) => {
  try {
    if (!TREND_WATCH_REMOTE_URL) {
      return res.json({ mode: 'local', imported: 0 });
    }
    const result = await syncIdeasFromRemote();
    res.json({ mode: 'remote', ...result });
  } catch (error) {
    console.error("Trend Watch sync failed:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ==========================================================================
   Project archives — export/import a project + all referenced media as one zip
   ========================================================================== */

// Every media filename a project references (only ones that actually exist)
function collectProjectMedia(project) {
  const names = new Set();
  const add = (f) => {
    const s = f && sanitizeFilename(f);
    if (s && fs.existsSync(path.join(outputsDir, s))) names.add(s);
  };
  (project.scenes || []).forEach(s => add(s.filename));
  if (project.audio) add(project.audio.filename);
  if (project.narrationAudio) add(project.narrationAudio.filename);
  if (project.masterTrack) add(project.masterTrack.filename);
  if (project.masterResult) add(project.masterResult.filename);
  if (project.lastRender) add(project.lastRender.filename);
  (project.thumbnails || []).forEach(t => add(t.filename));
  return [...names];
}

app.post('/api/project/export', async (req, res) => {
  const stamp = Date.now();
  const exportDir = path.join(outputsDir, `export_${stamp}`);
  try {
    const { project, name = 'project' } = req.body;
    if (!project) return res.status(400).json({ error: "Missing project data" });

    const media = collectProjectMedia(project);

    await fs.promises.mkdir(exportDir, { recursive: true });
    const jsonPath = path.join(exportDir, 'project.json');
    await fs.promises.writeFile(jsonPath, JSON.stringify(project, null, 2));

    const zipName = `omniproj_${String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}_${stamp}.zip`;
    const zipPath = path.join(outputsDir, zipName);
    const fileArgs = [jsonPath, ...media.map(m => path.join(outputsDir, m))].map(f => `"${f}"`).join(' ');
    await execAsync(`zip -j "${zipPath}" ${fileArgs}`);

    console.log(`Project exported: ${zipName} (${media.length} media files)`);
    res.json({ success: true, url: `/outputs/${zipName}`, filename: zipName, mediaCount: media.length });
  } catch (error) {
    console.error("Project export error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    fs.rm(exportDir, { recursive: true, force: true }, () => {});
  }
});

app.post('/api/project/import', upload.single('project'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No project archive uploaded" });
    const zipPath = req.file.path;

    // -j flattens paths: media lands directly in outputs/, no traversal possible
    await execAsync(`unzip -o -j "${zipPath}" -d "${outputsDir}"`);

    const projJsonPath = path.join(outputsDir, 'project.json');
    if (!fs.existsSync(projJsonPath)) {
      throw new Error("Not an OmniStudio project archive (project.json missing)");
    }
    const project = JSON.parse(await fs.promises.readFile(projJsonPath, 'utf8'));
    fs.unlink(projJsonPath, () => {});
    fs.unlink(zipPath, () => {});

    console.log(`Project imported: ${req.file.originalname} (media restored to outputs/)`);
    res.json({ success: true, project });
  } catch (error) {
    console.error("Project import error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* ==========================================================================
   Music Enhancer — intelligent mastering engine (Mixea-style)
   Two-pass loudness (measure → correct), style EQ + compression presets,
   optional stereo widening. Runs entirely locally via FFmpeg.
   ========================================================================== */

const MASTER_STYLES = {
  balanced: {
    label: 'Balanced',
    chain: 'bass=g=1.5:f=100,treble=g=1.5:f=8000,acompressor=threshold=-18dB:ratio=2:attack=20:release=250:makeup=2'
  },
  warm: {
    label: 'Warm & Smooth',
    chain: 'bass=g=3:f=90,treble=g=-1:f=9000,acompressor=threshold=-16dB:ratio=2.5:attack=25:release=300:makeup=2'
  },
  bright: {
    label: 'Bright & Open',
    chain: 'bass=g=0.5:f=100,treble=g=3:f=7500,acompressor=threshold=-18dB:ratio=2:attack=15:release=200:makeup=2'
  },
  punchy: {
    label: 'Loud & Punchy',
    chain: 'bass=g=2.5:f=80,treble=g=2:f=8000,acompressor=threshold=-14dB:ratio=3.5:attack=8:release=180:makeup=3'
  }
};

// First-pass loudness measurement (loudnorm prints JSON stats to stderr)
async function measureLoudness(filePath, targetI = -14) {
  const { stderr } = await execAsync(`ffmpeg -hide_banner -i "${filePath}" -af loudnorm=I=${targetI}:TP=-1.5:LRA=11:print_format=json -f null -`);
  const jsonMatch = stderr.match(/\{[^]*\}/);
  if (!jsonMatch) throw new Error("Loudness analysis produced no measurements");
  return JSON.parse(jsonMatch[0]);
}

app.post('/api/master-track', async (req, res) => {
  try {
    const { filename, style = 'balanced', targetLufs = -14, widen = true } = req.body;

    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename) return res.status(400).json({ error: "Missing track filename" });
    const inPath = path.join(outputsDir, safeFilename);
    if (!fs.existsSync(inPath)) return res.status(400).json({ error: "Track file not found" });

    const target = [-14, -11, -9.5].includes(parseFloat(targetLufs)) ? parseFloat(targetLufs) : -14;
    const preset = MASTER_STYLES[style] || MASTER_STYLES.balanced;

    console.log(`Mastering ${safeFilename} (style: ${preset.label}, target ${target} LUFS)...`);

    // Pass 1: measure the source so the correction is exact, not guesswork
    const measured = await measureLoudness(inPath, target);

    // Stereo widening only makes sense on stereo sources
    const { stdout: chOut } = await execAsync(`ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "${inPath}"`);
    const channels = parseInt(chOut.trim(), 10) || 2;
    const widenChain = (widen && channels >= 2) ? ',stereotools=slev=1.25' : '';

    // Pass 2: style EQ + glue compression + measured (linear) loudness correction
    const ln2 = `loudnorm=I=${target}:TP=-1.0:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
    const masteredFilename = `mastered_${style}_${Date.now()}.wav`;
    const outPath = path.join(outputsDir, masteredFilename);

    const masterCmd = `ffmpeg -y -i "${inPath}" -af "highpass=f=25,${preset.chain}${widenChain},${ln2},aresample=44100" -ar 44100 -c:a pcm_s16le "${outPath}"`;
    console.log("Mastering chain:", masterCmd);
    await execAsync(masterCmd);

    // Measure the result for the before/after report
    const after = await measureLoudness(outPath, target);

    res.json({
      success: true,
      url: `/outputs/${masteredFilename}`,
      filename: masteredFilename,
      report: {
        style: preset.label,
        targetLufs: target,
        widened: widen && channels >= 2,
        before: { lufs: parseFloat(measured.input_i), truePeak: parseFloat(measured.input_tp), lra: parseFloat(measured.input_lra) },
        after: { lufs: parseFloat(after.input_i), truePeak: parseFloat(after.input_tp), lra: parseFloat(after.input_lra) }
      }
    });
  } catch (error) {
    console.error("Mastering error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Full NLE Studio Video Compiler endpoint
app.post('/api/compile-studio-video', async (req, res) => {
  try {
    const {
      audioFilename,
      narrationFilename,
      scenes,
      lyrics = [],
      subtitleStyle = {},
      introCard = { enabled: false },
      outroCard = { enabled: false },
      orientation = 'landscape'
    } = req.body;

    if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: "Missing scenes array" });
    }
    for (const [label, card, subtitleKey] of [['Intro', introCard, 'subtitle'], ['Outro', outroCard, 'ctaText']]) {
      if (!card || !card.enabled) continue;
      const hasCopy = String(card.title || '').trim() && String(card[subtitleKey] || '').trim();
      const hasImage = String(card.imageFilename || '').trim() || String(card.imageBase64 || '').trim();
      if (!hasCopy || !hasImage) {
        return res.status(400).json({ error: `${label} card requires AI-generated contextual copy and background` });
      }
    }

    const outOrientation = orientation === 'vertical' ? 'vertical' : 'landscape';
    const { w: outW, h: outH } = getOutputDims(outOrientation);
    const safeAudioFilename = audioFilename ? sanitizeFilename(audioFilename) : null;
    const safeNarrationFilename = narrationFilename ? sanitizeFilename(narrationFilename) : null;
    console.log(`Compiling Studio Video (${outOrientation} ${outW}x${outH})...`, { scenesCount: scenes.length, lyricsCount: lyrics.length });

    // Finishing touches (Polish tab): transitions, audio ramps, loudness
    const polish = req.body.polish || {};
    const TRANSITIONS = ['fade', 'fadeblack', 'slideleft', 'circleopen'];
    const transition = TRANSITIONS.includes(polish.transition) ? polish.transition : 'cut';
    const td = Math.min(1.5, Math.max(0.2, parseFloat(polish.transitionDuration) || 0.5));
    const musicFadeIn = !!polish.musicFadeIn;
    const fadeInDur = Math.min(8, Math.max(1, parseFloat(polish.fadeInDuration) || 2));
    const audioFadeOut = !!polish.audioFadeOut;
    const useLoudnorm = !!polish.loudnorm;
    const videoFadeOut = !!polish.videoFadeOut;

    const tempFiles = [];
    const conformedPaths = [];
    const baseDurs = []; // planned timeline duration of every segment (sync-preserving)

    // Segment plan up front, so transition overlap extensions know which segment is last
    const hasIntro = !!(introCard && introCard.enabled);
    const hasOutro = !!(outroCard && outroCard.enabled);
    const validScenes = scenes.filter(s => sanitizeFilename(s.filename));
    const totalSegments = (hasIntro ? 1 : 0) + validScenes.length + (hasOutro ? 1 : 0);
    const useTransitions = transition !== 'cut' && totalSegments > 1;
    // Every non-last segment gets +td of extra footage: the cross-fade consumes exactly
    // that overlap, so every scene still starts on its planned timestamp (lyric sync safe)
    const extendFor = (idx) => (useTransitions && idx < totalSegments - 1 ? td : 0);
    let segIdx = 0;

    // Step 1: Handle Intro Card if enabled
    let introDuration = 0;
    if (hasIntro) {
      introDuration = Math.max(1, parseFloat(introCard.duration) || 4);
      const introFilename = `intro_${Date.now()}.mp4`;
      const introPath = path.join(outputsDir, introFilename);
      tempFiles.push(introPath);
      const introImgPath = await resolveCardImage(introCard, 'card_intro', tempFiles);
      const introTextOverlayPath = !ffmpegHasDrawtext && !introCard.hideText
        ? await createCardTextOverlay({
            title: introCard.title,
            subtitle: introCard.subtitle,
            subColor: '0xa78bfa',
            orientation: outOrientation,
            namePrefix: 'card_intro_text',
            tempFiles
          })
        : null;

      const introCmd = buildTitleCardCmd({
        bgColor: '0x0f172a',
        imgPath: introImgPath,
        textOverlayPath: introTextOverlayPath,
        imageMode: introCard.imageMode === 'background' ? 'background' : 'badge',
        kenBurns: !!introCard.kenBurns && !introCard.hideText,
        subscribe: !!introCard.subscribe,
  title: introCard.hideText ? '' : String(introCard.title || ''),
  subtitle: introCard.hideText ? '' : String(introCard.subtitle || ''),
        subColor: '0xa78bfa',
        duration: introDuration + extendFor(segIdx),
        outPath: introPath,
        orientation: outOrientation,
        tempFiles
      });
      console.log("Generating Intro Card:", introCmd);
      await execAsync(introCmd);
      conformedPaths.push(introPath);
      baseDurs.push(introDuration);
      segIdx++;
    }

    // Step 2: Conform all video scenes to the output size/fps
    for (let i = 0; i < validScenes.length; i++) {
      const scene = validScenes[i];
      const safeSceneFilename = sanitizeFilename(scene.filename);

      const duration = parseFloat(scene.duration) || 10.0;
      const inputPath = path.join(outputsDir, safeSceneFilename);
      const outputPath = path.join(outputsDir, `conformed_nle_${i}_${Date.now()}.mp4`);
      tempFiles.push(outputPath);

      const enc = getHardwareVideoEncoder();
      const conformCmd = `ffmpeg -y -stream_loop -1 -i "${inputPath}" -t ${(duration + extendFor(segIdx)).toFixed(3)} -vf "scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},fps=30" -an ${enc} -pix_fmt yuv420p "${outputPath}"`;

      console.log(`Conforming NLE scene ${i+1} (${duration}s):`, conformCmd);
      await execAsync(conformCmd);
      conformedPaths.push(outputPath);
      baseDurs.push(duration);
      segIdx++;
    }

    // Step 3: Handle Outro Card if enabled
    if (hasOutro) {
      const outroDuration = Math.max(1, parseFloat(outroCard.duration) || 4);
      const outroFilename = `outro_${Date.now()}.mp4`;
      const outroPath = path.join(outputsDir, outroFilename);
      tempFiles.push(outroPath);
      const outroImgPath = await resolveCardImage(outroCard, 'card_outro', tempFiles);
      const outroTextOverlayPath = !ffmpegHasDrawtext && !outroCard.hideText
        ? await createCardTextOverlay({
            title: outroCard.title,
            subtitle: outroCard.ctaText,
            subColor: '0x38bdf8',
            orientation: outOrientation,
            namePrefix: 'card_outro_text',
            tempFiles
          })
        : null;

      const outroCmd = buildTitleCardCmd({
        bgColor: '0x1e1b4b',
        imgPath: outroImgPath,
        textOverlayPath: outroTextOverlayPath,
        imageMode: outroCard.imageMode === 'background' ? 'background' : 'badge',
        kenBurns: !!outroCard.kenBurns && !outroCard.hideText,
        subscribe: !!outroCard.subscribe,
  title: outroCard.hideText ? '' : String(outroCard.title || ''),
  subtitle: outroCard.hideText ? '' : String(outroCard.ctaText || ''),
        subColor: '0x38bdf8',
        duration: outroDuration + extendFor(segIdx),
        outPath: outroPath,
        orientation: outOrientation,
        tempFiles
      });
      console.log("Generating Outro Card:", outroCmd);
      await execAsync(outroCmd);
      conformedPaths.push(outroPath);
      baseDurs.push(outroDuration);
      segIdx++;
    }

    const totalDur = baseDurs.reduce((a, b) => a + b, 0);

    // Step 4: Merge the silent video track — hard concat, or xfade transitions
    const mergedSilentPath = path.join(outputsDir, `merged_nle_silent_${Date.now()}.mp4`);
    tempFiles.push(mergedSilentPath);

    if (useTransitions) {
      const enc = getHardwareVideoEncoder();
      const inputArgs = conformedPaths.map(p => `-i "${p}"`).join(' ');
      // xfade refuses inputs with mismatched fps/timebase (title cards render at
      // 25fps, scene clips at 30fps) — normalize every input first
      let filter = conformedPaths.map((_, i) => `[${i}:v]fps=30,settb=AVTB[vn${i}];`).join('');
      let prevLabel = '[vn0]';
      let cumBase = 0;
      for (let i = 1; i < conformedPaths.length; i++) {
        cumBase += baseDurs[i - 1];
        const outLabel = (i === conformedPaths.length - 1) ? '[vout]' : `[vx${i}]`;
        filter += `${prevLabel}[vn${i}]xfade=transition=${transition}:duration=${td}:offset=${cumBase.toFixed(3)}${outLabel};`;
        prevLabel = outLabel;
      }
      filter = filter.slice(0, -1);
      const xfadeCmd = `ffmpeg -y ${inputArgs} -filter_complex "${filter}" -map "[vout]" ${enc} -pix_fmt yuv420p "${mergedSilentPath}"`;
      console.log(`Blending ${conformedPaths.length} segments with '${transition}' transitions:`, xfadeCmd);
      await execAsync(xfadeCmd);
    } else {
      const concatTxtContent = conformedPaths.map(p => `file '${p}'`).join('\n');
      const concatTxtPath = path.join(outputsDir, `concat_nle_${Date.now()}.txt`);
      tempFiles.push(concatTxtPath);
      await fs.promises.writeFile(concatTxtPath, concatTxtContent);

      const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${concatTxtPath}" -c copy "${mergedSilentPath}"`;
      console.log("Concatenating NLE video segments:", concatCmd);
      await execAsync(concatCmd);
    }

    // Step 5: Keep subtitles as separate closed captions; never burn them into the video.
    let finalVideoWithSubtitlesPath = mergedSilentPath;

    // Step 5b: Channel logo watermark — present across the ENTIRE video (cards + scenes)
    const logo = req.body.logo || null;
    if (logo && (logo.filename || logo.imageBase64)) {
      let logoPath = null;
      if (logo.filename) {
        const safeLogo = sanitizeFilename(logo.filename);
        const p = safeLogo && path.join(outputsDir, safeLogo);
        if (p && fs.existsSync(p)) logoPath = p;
      }
      if (!logoPath && logo.imageBase64) {
        logoPath = await writeCardImage(logo.imageBase64, 'wm_logo', tempFiles);
      }

      if (logoPath) {
        const sizeFrac = Math.min(0.3, Math.max(0.06, parseFloat(logo.size) || 0.12));
        const opacity = Math.min(1, Math.max(0.2, parseFloat(logo.opacity) || 0.85));
        const margin = Math.round(outW * 0.02);
        const posMap = {
          'top-left': `${margin}:${margin}`,
          'top-right': `W-w-${margin}:${margin}`,
          'bottom-left': `${margin}:H-h-${margin}`,
          'bottom-right': `W-w-${margin}:H-h-${margin}`
        };
        const pos = posMap[logo.position] || posMap['top-right'];
        const logoW = Math.round(outW * sizeFrac);

        const watermarkedPath = path.join(outputsDir, `watermarked_${Date.now()}.mp4`);
        tempFiles.push(watermarkedPath);
        const enc5b = getHardwareVideoEncoder();
        const wmCmd = `ffmpeg -y -i "${finalVideoWithSubtitlesPath}" -i "${logoPath}" -filter_complex "[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=${opacity}[lg];[0:v][lg]overlay=${pos}" ${enc5b} -pix_fmt yuv420p "${watermarkedPath}"`;
        console.log("Applying channel logo watermark:", wmCmd);
        await execAsync(wmCmd);
        finalVideoWithSubtitlesPath = watermarkedPath;
      }
    }

    // Step 6: Mix Master Audio Track (music and/or TTS narration, both offset by intro)
    const finalFilename = `youtube_master_${Date.now()}.mp4`;
    const finalFilePath = path.join(outputsDir, finalFilename);

    const delayMs = Math.round(introDuration * 1000);
    const audioPath = safeAudioFilename ? path.join(outputsDir, safeAudioFilename) : null;
    const narrationPath = safeNarrationFilename ? path.join(outputsDir, safeNarrationFilename) : null;

    // Polish pieces for the audio chain:
    // - music fade-in starts when the music starts (after the intro card)
    // - master fade-out over the last 3s; loudness normalized to YouTube's -14 LUFS
    const musicFade = musicFadeIn ? `,afade=t=in:st=0:d=${fadeInDur}` : '';
    // apad + "-t totalDur": the video's length governs the output. Without it, a
    // music bed shorter than video+cards would truncate the ending via -shortest.
    const audioPost = ['apad'];
    if (audioFadeOut) audioPost.push(`afade=t=out:st=${Math.max(0, totalDur - 3).toFixed(2)}:d=3`);
    if (useLoudnorm) audioPost.push('loudnorm=I=-14:TP=-1.5:LRA=11', 'aresample=48000');
    const mixLabel = '[premix]';
    const postChain = `;[premix]${audioPost.join(',')}[aout]`;
    const durCap = `-t ${totalDur.toFixed(3)}`;

    // Optional cinematic ending: video fades to black over the last 1.2s (re-encode)
    const enc6 = getHardwareVideoEncoder();
    const vFadeFilter = videoFadeOut ? `[0:v]fade=t=out:st=${Math.max(0, totalDur - 1.2).toFixed(2)}:d=1.2[vout];` : '';
    const vMapArgs = videoFadeOut ? `-map "[vout]" ${enc6} -pix_fmt yuv420p` : `-map 0:v -c:v copy`;

    let finalMixCmd = '';
    if (audioPath && narrationPath) {
      // Sidechain ducking: music dips only while the voice is actually speaking,
      // and swells back between narration lines (instead of a flat 35% volume)
      finalMixCmd = `ffmpeg -y -i "${finalVideoWithSubtitlesPath}" -i "${audioPath}" -i "${narrationPath}" -filter_complex "${vFadeFilter}[1:a]aloop=loop=-1:size=2e+09,adelay=${delayMs}|${delayMs},volume=0.9${musicFade}[music];[2:a]adelay=${delayMs}|${delayMs},asplit=2[sc][voice];[music][sc]sidechaincompress=threshold=0.02:ratio=12:attack=15:release=500[ducked];[ducked][voice]amix=inputs=2:duration=longest:normalize=0${mixLabel}${postChain}" ${vMapArgs} -map "[aout]" -c:a aac ${durCap} "${finalFilePath}"`;
    } else if (narrationPath) {
      finalMixCmd = `ffmpeg -y -i "${finalVideoWithSubtitlesPath}" -i "${narrationPath}" -filter_complex "${vFadeFilter}[1:a]adelay=${delayMs}|${delayMs}${mixLabel}${postChain}" ${vMapArgs} -map "[aout]" -c:a aac ${durCap} "${finalFilePath}"`;
    } else if (audioPath) {
      finalMixCmd = `ffmpeg -y -i "${finalVideoWithSubtitlesPath}" -i "${audioPath}" -filter_complex "${vFadeFilter}[1:a]aloop=loop=-1:size=2e+09,adelay=${delayMs}|${delayMs}${musicFade}${mixLabel}${postChain}" ${vMapArgs} -map "[aout]" -c:a aac ${durCap} "${finalFilePath}"`;
    } else if (videoFadeOut) {
      // No audio track — still honor the video fade-out
      finalMixCmd = `ffmpeg -y -i "${finalVideoWithSubtitlesPath}" -vf "fade=t=out:st=${Math.max(0, totalDur - 1.2).toFixed(2)}:d=1.2" ${enc6} -pix_fmt yuv420p -an "${finalFilePath}"`;
    } else {
      // No audio at all - output video only
      finalMixCmd = `ffmpeg -y -i "${finalVideoWithSubtitlesPath}" -c copy "${finalFilePath}"`;
    }

    console.log("Finalizing NLE Master Video with audio:", finalMixCmd);
    await execAsync(finalMixCmd);

    // Cleanup temporary files asynchronously
    tempFiles.forEach(file => {
      fs.unlink(file, (err) => { if (err) console.error("Error deleting temp NLE file:", err); });
    });

    console.log(`Successfully rendered NLE master YouTube video to ${finalFilePath}`);
    await persistMirror(finalFilename);

    res.json({
      success: true,
      videoUrl: `/outputs/${finalFilename}`,
      filename: finalFilename
    });

  } catch (error) {
    console.error("Error compiling NLE Studio video:", error);
    await notifyUser({
      title: '⚠️ OmniStudio: Video Render Error',
      message: `Studio master video compilation failed: ${error.message}`
    }).catch(() => {});
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, async () => {
  console.log(`OmniKids Studio running on http://localhost:${PORT}`);
  // Bring up optional Google Cloud sync (Storage + Firestore) before other init
  await initCloud().catch(err => console.warn("Cloud init failed:", err.message));
  if (!cloud.enabled) console.log("☁️  Cloud sync off (local files + localStorage). Set GCS_BUCKET / GCP_PROJECT_ID to enable.");
  // Resume the Trend Watch schedule if it was enabled
  applyTrendWatchSchedule().catch(err => console.warn("Trend Watch schedule init failed:", err.message));
});

