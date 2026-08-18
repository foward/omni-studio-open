// Application State
const state = {
  presets: null,
  mode: 'music', // project type: 'music' | 'explainer'
  step: 1, // wizard step: 1 Setup, 2 Storyboard, 3 Studio, 4 Publish
  explainer: null, // { topic, videoTitle, durationSeconds }
  pendingBrief: null, // { angle, hook, keyPoints[], targetAudience } carried from a trend/idea
  audio: null, // { filename: string, duration: number }
  narrationAudio: null, // { filename, duration } — generated TTS voiceover track
  timedLyrics: null, // [{ text, startTime, duration }] — real line timings from transcription
  cardImages: { intro: null, outro: null }, // downscaled data URLs composited onto title cards
  brandRef: null, // project-level art override (data URL) — conditions AI backgrounds & thumbnails
  channelId: null, // planner channel this project belongs to — its brand kit applies first
  youtubeChannelId: null, // independent Planner channel whose saved token receives Publish uploads
  projectLogo: null, // { filename } or { dataUrl } — watermark fallback when the channel has no logo
  orientation: 'landscape', // 'landscape' (16:9) | 'vertical' (9:16 Shorts/Reels)
  lastContentMode: 'music', // content type to return to when leaving Master mode
  masterTrack: null, // { filename, duration, displayName } — source for the mastering engine
  masterResult: null, // { filename, url, report } — last mastered output
  lastSEOKit: null, // most recent SEO kit (feeds thumbnails + publish package)
  thumbnails: [], // [{ url, filename }] generated thumbnail images
  localizations: [], // [{ langCode, language, lines, voiceover, title, description, tags }]
  lastRender: null, // { filename } of the last rendered master video
  shorts: [], // [{ filename, url, title, reason, startSec, endSec, duration }] auto-cut verticals
  activeCharacter: null, // { type: 'preset'|'custom', name: string, fileUrl | data, mimeType }
  scenes: Array(4).fill(null).map((_, i) => ({
    index: i,
    start: null,
    end: null,
    prompt: '',
    generatedUrl: null,
    filename: null,
    generating: false
  }))
};

// Send desktop / macOS native notification
async function sendNativeNotification(title, message) {
  try {
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message })
    });
  } catch (e) {}

  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(title, { body: message });
      } else if (Notification.permission === 'default') {
        Notification.requestPermission();
      }
    }
  } catch (e) {}
}

// DOM Elements
const btnTypeMusic = document.getElementById('btnTypeMusic');
const btnTypeExplainer = document.getElementById('btnTypeExplainer');
const musicSetupGroup = document.getElementById('musicSetupGroup');
const stepperButtons = document.querySelectorAll('.stepper-step');
const stepPanels = [1, 2, 3, 4].map(n => document.getElementById(`stepPanel${n}`));
const syncConfigSection = document.getElementById('syncConfigSection');
const presetsGrid = document.getElementById('presetsGrid');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadPreviewContainer = document.getElementById('uploadPreviewContainer');
const uploadPreview = document.getElementById('uploadPreview');
const btnRemoveUpload = document.getElementById('btnRemoveUpload');
const storyboardGrid = document.getElementById('storyboardGrid');
const storyboardDesc = document.getElementById('storyboardDesc');
const btnCompile = document.getElementById('btnCompile');
const btnGenerateAll = document.getElementById('btnGenerateAll');
const compileStatusText = document.getElementById('compileStatusText');
const compileDesc = document.getElementById('compilationDesc');
const mergedVideoDisplay = document.getElementById('mergedVideoDisplay');
const finalVideo = document.getElementById('finalVideo');
const downloadLink = document.getElementById('downloadLink');
const btnResetAll = document.getElementById('btnResetAll');
const btnUploadToGCS = document.getElementById('btnUploadToGCS');
const toastContainer = document.getElementById('toastContainer');

// Lyric Sync DOM Elements
const audioDropZone = document.getElementById('audioDropZone');
const audioFileInput = document.getElementById('audioFileInput');
const audioDropText = document.getElementById('audioDropText');
const audioPreviewContainer = document.getElementById('audioPreviewContainer');
const audioFilenameText = document.getElementById('audioFilenameText');
const audioDurationText = document.getElementById('audioDurationText');
const btnRemoveAudio = document.getElementById('btnRemoveAudio');
const lyricsInput = document.getElementById('lyricsInput');
const btnGenerateScript = document.getElementById('btnGenerateScript');
const chkAutoTranscribe = document.getElementById('chkAutoTranscribe');

// Explainer Mode DOM Elements
const explainerConfigSection = document.getElementById('explainerConfigSection');
const explainerTopicInput = document.getElementById('explainerTopicInput');
const explainerDuration = document.getElementById('explainerDuration');
const explainerStyle = document.getElementById('explainerStyle');
const btnGenerateExplainerPlan = document.getElementById('btnGenerateExplainerPlan');

// SEO Kit DOM Elements
const seoSection = document.getElementById('seoSection');
const btnGenerateSEO = document.getElementById('btnGenerateSEO');
const seoResults = document.getElementById('seoResults');

// Init
window.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadPresets();
  projectsIndex = loadProjectsIndex();
  await syncProjectsFromCloud(); // merge in the shared library if cloud sync is on
  persistProjectsIndex();
  renderProjectSelect();
  const restored = restoreProject();
  if (!restored) renderStoryboard();
  initProjectPersistence();
  populateProjectChannelSelect(); // async; fills the top-bar channel picker

  // Landing decision: if we just reloaded to start a chosen format, enter it;
  // else resume a project with content; otherwise show the Home hub (so the root
  // never drops you into a blank auto-created project).
  const pending = (() => { try { return JSON.parse(sessionStorage.getItem('omni_pending_mode')); } catch { return null; } })();
  if (pending) {
    sessionStorage.removeItem('omni_pending_mode');
    state.channelId = pending.channelId || null;
    populateProjectChannelSelect();
    setLandingVisible(false);
    if (state.mode !== pending.mode) setProjectType(pending.mode); else goToStep(1);
    const cur = projectsIndex.projects[projectsIndex.currentId];
    showToast(`New ${MODE_LABELS[pending.mode]} project: "${cur ? cur.name : ''}"`, 'success');
  } else if (!restored) {
    setLandingVisible(true);
  }

  // Returned from YouTube OAuth consent → jump to Publish and show status
  const ytParam = new URLSearchParams(location.search).get('youtube');
  const ytChannelParam = new URLSearchParams(location.search).get('channelId');
  if (ytParam) {
    if (ytChannelParam) state.youtubeChannelId = ytChannelParam;
    history.replaceState({}, '', location.pathname);
    showToast(ytParam === 'connected' ? 'YouTube connected!' : 'YouTube connection failed.', ytParam === 'connected' ? 'success' : 'error');
    goToStep(4);
  }
});

// Setup Events
function setupEventListeners() {
  // Project Type Selector Handlers
  if (btnTypeMusic) btnTypeMusic.addEventListener('click', () => setProjectType('music'));
  if (btnTypeExplainer) btnTypeExplainer.addEventListener('click', () => setProjectType('explainer'));
  const btnTypeMaster = document.getElementById('btnTypeMaster');
  if (btnTypeMaster) btnTypeMaster.addEventListener('click', () => setProjectType('master'));

  // Landing / Home hub
  const btnHome = document.getElementById('btnHome');
  if (btnHome) btnHome.addEventListener('click', () => setLandingVisible(true));
  document.querySelectorAll('[data-landing-mode]').forEach(card =>
    card.addEventListener('click', () => startFromLanding(card.dataset.landingMode)));
  const landingManage = document.getElementById('landingManage');
  if (landingManage) landingManage.addEventListener('click', () => { setLandingVisible(false); openProjectsManager(); });
  const landingChannel = document.getElementById('landingChannel');
  if (landingChannel) landingChannel.addEventListener('change', () => { state.channelId = landingChannel.value || null; });

  // Music Master (intelligent mastering engine)
  const btnMasterUpload = document.getElementById('btnMasterUpload');
  const masterFileInput = document.getElementById('masterFileInput');
  if (btnMasterUpload && masterFileInput) {
    btnMasterUpload.addEventListener('click', () => masterFileInput.click());
    masterFileInput.addEventListener('change', handleMasterUpload);
  }
  const btnMasterUseProject = document.getElementById('btnMasterUseProject');
  if (btnMasterUseProject) btnMasterUseProject.addEventListener('click', useProjectTrackForMaster);
  const btnMasterTrack = document.getElementById('btnMasterTrack');
  if (btnMasterTrack) btnMasterTrack.addEventListener('click', masterTrackNow);
  const btnMasterUseResult = document.getElementById('btnMasterUseResult');
  if (btnMasterUseResult) btnMasterUseResult.addEventListener('click', useMasteredAsProjectAudio);

  // Wizard Stepper Handlers
  stepperButtons.forEach(btn => {
    btn.addEventListener('click', () => goToStep(parseInt(btn.dataset.step, 10)));
  });
  const btnToStep2 = document.getElementById('btnToStep2');
  const btnToStep3 = document.getElementById('btnToStep3');
  const btnToStep4 = document.getElementById('btnToStep4');
  if (btnToStep2) btnToStep2.addEventListener('click', () => goToStep(2));
  if (btnToStep3) btnToStep3.addEventListener('click', () => goToStep(3));
  if (btnToStep4) btnToStep4.addEventListener('click', () => goToStep(4));

  // Explainer plan + SEO kit + Voiceover handlers
  if (btnGenerateExplainerPlan) btnGenerateExplainerPlan.addEventListener('click', generateExplainerPlan);
  const btnClearBrief = document.getElementById('btnClearBrief');
  if (btnClearBrief) btnClearBrief.addEventListener('click', () => {
    state.pendingBrief = null;
    renderExplainerBrief();
    showToast("Brief cleared — the plan will be generated from just the topic.", "info");
  });
  if (btnGenerateSEO) btnGenerateSEO.addEventListener('click', generateSEOKit);

  // Scene refinement + segment listening: delegated so listeners survive re-renders
  if (storyboardGrid) {
    storyboardGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-refine]');
      if (btn && !btn.disabled) refineScene(parseInt(btn.dataset.refine, 10));
      const listenBtn = e.target.closest('[data-listen]');
      if (listenBtn) toggleScenePreview(parseInt(listenBtn.dataset.listen, 10));
      const stockBtn = e.target.closest('[data-stock]');
      if (stockBtn) toggleStockPicker(parseInt(stockBtn.dataset.stock, 10));
    });
    storyboardGrid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const input = e.target.closest('[data-refine-input]');
      if (input && !input.disabled) refineScene(parseInt(input.dataset.refineInput, 10));
    });
  }

  // Publish step: thumbnails + package export
  const btnGenerateThumbs = document.getElementById('btnGenerateThumbs');
  if (btnGenerateThumbs) btnGenerateThumbs.addEventListener('click', generateThumbnails);
  const btnExportPackage = document.getElementById('btnExportPackage');
  if (btnExportPackage) btnExportPackage.addEventListener('click', exportPublishPackage);
  const btnArchiveLibrary = document.getElementById('btnArchiveLibrary');
  if (btnArchiveLibrary) btnArchiveLibrary.addEventListener('click', archiveToCloudLibrary);
  const btnLocalize = document.getElementById('btnLocalize');
  if (btnLocalize) btnLocalize.addEventListener('click', generateLocalizations);
  const btnGenerateShorts = document.getElementById('btnGenerateShorts');
  if (btnGenerateShorts) btnGenerateShorts.addEventListener('click', generateShorts);

  // Channel Manager shared file input (brand kit = downscaled JPEG; logo = as-is to keep PNG alpha)
  const cmFileInput = document.getElementById('cmFileInput');
  if (cmFileInput) cmFileInput.addEventListener('change', async () => {
    const file = cmFileInput.files && cmFileInput.files[0];
    cmFileInput.value = '';
    if (!file || !file.type.startsWith('image/') || !cmFileTarget) return;
    const { channelId, kind } = cmFileTarget;
    cmFileTarget = null;
    try {
      if (kind === 'brand') {
        const imageBase64 = await downscaleImageFile(file, 768);
        const res = await fetch('/api/channel-brand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId, imageBase64 }) });
        if (!res.ok) throw new Error((await res.json()).error || 'upload failed');
        showToast('Brand kit updated — AI images for this channel will match it.', 'success');
      } else {
        const imageBase64 = await readFileAsDataURL(file);
        const res = await fetch('/api/channel-logo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId, imageBase64 }) });
        if (!res.ok) throw new Error((await res.json()).error || 'upload failed');
        showToast('Logo updated — it watermarks every video for this channel.', 'success');
      }
      await refreshChannelAssets(channelId);
    } catch (err) {
      showToast(`Upload failed: ${err.message}`, 'error');
    }
  });

  // Full Autopilot manual scan
  const btnFaScanNow = document.getElementById('btnFaScanNow');
  if (btnFaScanNow) btnFaScanNow.addEventListener('click', async () => {
    const status = document.getElementById('faScanStatus');
    btnFaScanNow.disabled = true;
    if (status) status.innerText = 'Scanning channels…';
    try {
      const response = await fetch('/api/autopilot/auto-run', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Scan failed');
      if (status) status.innerText = data.queued > 0 ? `Queued ${data.queued} next job(s).` : 'Nothing to queue — enabled channels already have work pending or no unused ideas remain.';
      renderAutopilotQueue();
    } catch (err) {
      if (status) status.innerText = `Scan failed: ${err.message}`;
    } finally {
      btnFaScanNow.disabled = false;
    }
  });

  const btnFaDrain = document.getElementById('btnFaDrain');
  if (btnFaDrain) btnFaDrain.addEventListener('click', async () => {
    const enableDrain = btnFaDrain.dataset.draining !== 'true';
    btnFaDrain.disabled = true;
    try {
      const response = await fetch('/api/autopilot/drain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enableDrain })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not change Autopilot mode');
      updateAutopilotDrainControls(data.draining, data.outstanding);
      showToast(data.draining
        ? `Autopilot will stop after ${data.outstanding} outstanding job${data.outstanding === 1 ? '' : 's'} finish.`
        : 'Continuous Autopilot generation resumed.', 'success');
      renderAutopilotQueue();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btnFaDrain.disabled = false;
    }
  });

  // Autopilot modal
  const apCancelBtn = document.getElementById('apCancel');
  if (apCancelBtn) apCancelBtn.addEventListener('click', closeAutopilotModal);
  const apLaunchBtn = document.getElementById('apLaunch');
  if (apLaunchBtn) apLaunchBtn.addEventListener('click', launchAutopilotJob);
  const apBackdrop = document.getElementById('apModalBackdrop');
  if (apBackdrop) apBackdrop.addEventListener('click', (e) => { if (e.target === apBackdrop) closeAutopilotModal(); });
  const btnChaptersRefresh = document.getElementById('btnChaptersRefresh');
  if (btnChaptersRefresh) btnChaptersRefresh.addEventListener('click', () => refreshChapterUI(true));
  const btnChaptersCopy = document.getElementById('btnChaptersCopy');
  if (btnChaptersCopy) btnChaptersCopy.addEventListener('click', () => {
    const box = document.getElementById('chapterText');
    if (!box || !box.value.trim()) { showToast('No chapters to copy yet.', 'warning'); return; }
    navigator.clipboard.writeText(box.value.trim());
    showToast('Chapters copied — paste them into any video description.', 'success');
  });
  const chapterBoxEl = document.getElementById('chapterText');
  if (chapterBoxEl) chapterBoxEl.addEventListener('input', () => refreshChapterUI());
  const btnYtUpload = document.getElementById('btnYtUpload');
  if (btnYtUpload) btnYtUpload.addEventListener('click', uploadToYouTube);
  const ytChannelSelect = document.getElementById('ytChannelSelect');
  if (ytChannelSelect) ytChannelSelect.addEventListener('change', () => {
    state.youtubeChannelId = ytChannelSelect.value || null;
    scheduleProjectSave();
    refreshYouTubeStatus();
  });
  const btnYtConnect = document.getElementById('btnYtConnect');
  if (btnYtConnect) btnYtConnect.addEventListener('click', async () => {
    const channelId = selectedYouTubeChannelId();
    if (!channelId) {
      showToast('Select a YouTube destination first.', 'warning');
      return;
    }
    const res = await fetch('/api/youtube/auth/system', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Could not open YouTube authorization.', 'error');
      return;
    }
    showToast('Continue authorization in your system browser.', 'info');
  });
  const btnYtDisconnect = document.getElementById('btnYtDisconnect');
  if (btnYtDisconnect) btnYtDisconnect.addEventListener('click', async () => {
    await fetch('/api/youtube/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: selectedYouTubeChannelId() })
    });
    showToast('Disconnected from YouTube.', 'info');
    refreshYouTubeStatus();
  });
  const btnGenerateVoiceover = document.getElementById('btnGenerateVoiceover');
  if (btnGenerateVoiceover) btnGenerateVoiceover.addEventListener('click', generateVoiceover);

  // Song source toggle + Lyria song generation handlers
  const btnSongUploadMode = document.getElementById('btnSongUploadMode');
  const btnSongGenerateMode = document.getElementById('btnSongGenerateMode');
  const songUploadPanel = document.getElementById('songUploadPanel');
  const songGeneratePanel = document.getElementById('songGeneratePanel');
  if (btnSongUploadMode && btnSongGenerateMode) {
    btnSongUploadMode.addEventListener('click', () => {
      btnSongUploadMode.classList.add('active');
      btnSongGenerateMode.classList.remove('active');
      songUploadPanel.style.display = 'block';
      songGeneratePanel.style.display = 'none';
    });
    btnSongGenerateMode.addEventListener('click', () => {
      btnSongGenerateMode.classList.add('active');
      btnSongUploadMode.classList.remove('active');
      songGeneratePanel.style.display = 'block';
      songUploadPanel.style.display = 'none';
    });
  }
  const btnGenerateSong = document.getElementById('btnGenerateSong');
  if (btnGenerateSong) btnGenerateSong.addEventListener('click', generateSong);
  const btnRegenerateSong = document.getElementById('btnRegenerateSong');
  if (btnRegenerateSong) btnRegenerateSong.addEventListener('click', () => { stopAuditions(); generateSong(); });
  const btnKeepSong = document.getElementById('btnKeepSong');
  if (btnKeepSong) btnKeepSong.addEventListener('click', () => {
    stopAuditions();
    document.getElementById('songAuditionBox').style.display = 'none';
    showToast("Song kept. Continue to generate the scene script.", "success");
  });

  // Manual lyric edits invalidate transcribed line timings
  if (lyricsInput) {
    lyricsInput.addEventListener('input', () => { state.timedLyrics = null; });
  }

  // SRT subtitle export
  const btnDownloadSRT = document.getElementById('btnDownloadSRT');
  if (btnDownloadSRT) btnDownloadSRT.addEventListener('click', downloadSRT);

  // Subtitle editor: shift-all controls + refresh when the tab opens
  const subShiftMinus = document.getElementById('subShiftMinus');
  if (subShiftMinus) subShiftMinus.addEventListener('click', () => shiftAllSubtitles(-0.2));
  const subShiftPlus = document.getElementById('subShiftPlus');
  if (subShiftPlus) subShiftPlus.addEventListener('click', () => shiftAllSubtitles(0.2));
  const tabSubsBtn = document.getElementById('tabSubtitlesBtn');
  if (tabSubsBtn) tabSubsBtn.addEventListener('click', renderSubtitleEditor);

  // Continuity agent (prompt-level, pre-generation)
  const btnCoherenceCheck = document.getElementById('btnCoherenceCheck');
  if (btnCoherenceCheck) btnCoherenceCheck.addEventListener('click', () => runCoherenceCheck(false));

  // Video realism agent (watches generated clips, post-generation)
  const btnRealismCheck = document.getElementById('btnRealismCheck');
  if (btnRealismCheck) btnRealismCheck.addEventListener('click', runRealismCheck);

  // Output orientation toggle (landscape / vertical)
  const orientationToggle = document.getElementById('orientationToggle');
  if (orientationToggle) {
    orientationToggle.querySelectorAll('.orientation-btn').forEach(btn => {
      btn.addEventListener('click', () => setOrientation(btn.dataset.orientation));
    });
  }

  // Title card image pickers
  setupCardImagePicker('intro', 'btnIntroImagePick', 'introImageInput', 'introImageThumb', 'btnIntroImageRemove');
  setupCardImagePicker('outro', 'btnOutroImagePick', 'outroImageInput', 'outroImageThumb', 'btnOutroImageRemove');

  // Project ↔ channel link (channel brand kit drives AI image styling)
  const projectChannel = document.getElementById('projectChannel');
  if (projectChannel) {
    projectChannel.addEventListener('change', () => {
      state.channelId = projectChannel.value || null;
      updateChannelBrandInfo();
      updateLogoUI();
      if (state.channelId) applyChannelDefaults(state.channelId); // voice, visual style, subtitles
      scheduleProjectSave();
      if (state.channelId) showToast("Project linked to channel — its brand kit & style now apply.", "success");
    });
  }

  // Channel logo watermark controls (Polish tab)
  const btnGenerateLogo = document.getElementById('btnGenerateLogo');
  if (btnGenerateLogo) btnGenerateLogo.addEventListener('click', generateLogoFlow);
  const btnUploadLogo = document.getElementById('btnUploadLogo');
  const logoFileInput = document.getElementById('logoFileInput');
  if (btnUploadLogo && logoFileInput) {
    btnUploadLogo.addEventListener('click', () => logoFileInput.click());
    logoFileInput.addEventListener('change', async () => {
      const file = logoFileInput.files && logoFileInput.files[0];
      logoFileInput.value = '';
      if (!file || !file.type.startsWith('image/')) return;
      try {
        await uploadLogoFile(file);
        showToast("Logo saved — it will stay on screen for the whole video.", "success");
      } catch (err) {
        showToast(`Logo upload failed: ${err.message}`, "error");
      }
    });
  }
  ['logoEnabled', 'logoPosition', 'logoSize', 'logoOpacity'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateLogoUI);
  });

  // Brand reference (album cover / character art) for AI image conditioning
  const btnBrandPick = document.getElementById('btnBrandPick');
  const brandInput = document.getElementById('brandInput');
  if (btnBrandPick && brandInput) {
    btnBrandPick.addEventListener('click', () => brandInput.click());
    brandInput.addEventListener('change', async () => {
      const file = brandInput.files && brandInput.files[0];
      brandInput.value = '';
      if (!file || !file.type.startsWith('image/')) return;
      try {
        state.brandRef = await downscaleImageFile(file, 768);
        updateBrandUI();
        scheduleProjectSave();
        showToast("Brand reference saved — AI backgrounds & thumbnails will match this art.", "success");
      } catch (err) {
        showToast("Could not read that image.", "error");
      }
    });
  }
  const btnBrandRemove = document.getElementById('btnBrandRemove');
  if (btnBrandRemove) btnBrandRemove.addEventListener('click', () => {
    state.brandRef = null;
    updateBrandUI();
    scheduleProjectSave();
  });

  // AI-generated card backgrounds + live overlay refresh on style changes
  const btnIntroAIBg = document.getElementById('btnIntroAIBg');
  if (btnIntroAIBg) btnIntroAIBg.addEventListener('click', () => generateCardBackground('intro'));
  const btnOutroAIBg = document.getElementById('btnOutroAIBg');
  if (btnOutroAIBg) btnOutroAIBg.addEventListener('click', () => generateCardBackground('outro'));
  ['introImageMode', 'introKenBurns', 'introSubscribe', 'outroImageMode', 'outroKenBurns', 'outroSubscribe'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => updateTitleCardOverlay(nleState.currentTime));
  });

  // Background music handlers
  const btnGenerateMusic = document.getElementById('btnGenerateMusic');
  if (btnGenerateMusic) btnGenerateMusic.addEventListener('click', generateMusic);
  const btnRegenerateMusic = document.getElementById('btnRegenerateMusic');
  if (btnRegenerateMusic) btnRegenerateMusic.addEventListener('click', () => { stopAuditions(); generateMusic(); });
  const btnKeepMusic = document.getElementById('btnKeepMusic');
  if (btnKeepMusic) btnKeepMusic.addEventListener('click', () => {
    stopAuditions();
    document.getElementById('musicAuditionBox').style.display = 'none';
    showToast("Background music kept.", "success");
  });
  if (musicMoodSelect) {
    musicMoodSelect.addEventListener('change', () => {
      if (musicMoodSelect.value) {
        musicPromptInput.value = musicMoodSelect.value;
      } else if (state.explainer && state.explainer.musicPrompt) {
        musicPromptInput.value = state.explainer.musicPrompt;
      }
    });
  }

  // File Upload Handlers
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileSelect);
  
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      processFile(e.dataTransfer.files[0]);
    }
  });

  btnRemoveUpload.addEventListener('click', removeCustomUpload);

  // Audio Upload Handlers
  audioDropZone.addEventListener('click', () => audioFileInput.click());
  audioFileInput.addEventListener('change', handleAudioSelect);

  audioDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    audioDropZone.classList.add('dragover');
  });

  audioDropZone.addEventListener('dragleave', () => {
    audioDropZone.classList.remove('dragover');
  });

  audioDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    audioDropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      processAudioFile(e.dataTransfer.files[0]);
    }
  });

  btnRemoveAudio.addEventListener('click', removeAudioFile);

  // AI Script Generation Handler
  btnGenerateScript.addEventListener('click', generateAIScript);
  chkAutoTranscribe.addEventListener('change', handleAutoTranscribeChange);

  // Compile button
  btnCompile.addEventListener('click', compileMusicVideo);
  btnGenerateAll.addEventListener('click', generateAllScenesSequentially);

  // Reset button
  btnResetAll.addEventListener('click', resetStudio);
  if (btnUploadToGCS) btnUploadToGCS.addEventListener('click', uploadLastRenderToGCS);
}

let originalLyricsPlaceholder = "Paste the children's song lyrics here (e.g. Twinkle Twinkle Little Star...)";
let tempTypedLyrics = "";

function handleAutoTranscribeChange() {
  if (chkAutoTranscribe.checked) {
    tempTypedLyrics = lyricsInput.value;
    lyricsInput.value = "";
    lyricsInput.disabled = true;
    lyricsInput.placeholder = "Lyrics will be automatically transcribed from the uploaded music track...";
    btnGenerateScript.innerText = "Transcribe Audio & Generate Script";
  } else {
    lyricsInput.disabled = false;
    lyricsInput.value = tempTypedLyrics;
    lyricsInput.placeholder = originalLyricsPlaceholder;
    btnGenerateScript.innerText = "Generate Script with AI";
  }
}

// Show Toast message
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✨' : type === 'error' ? '❌' : 'ℹ️'}</span>
    <div>${message}</div>
  `;
  toastContainer.appendChild(toast);

  // Auto remove
  setTimeout(() => {
    toast.style.transform = 'translateX(120%)';
    toast.style.transition = 'transform 0.3s ease-in';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Switch Project Type (Music Video ↔ AI Explainer)
// Apply all show/hide UI for the current state.mode (music | explainer | master)
function applyProjectTypeUI() {
  const m = state.mode;
  if (btnTypeMusic) btnTypeMusic.classList.toggle('active', m === 'music');
  if (btnTypeExplainer) btnTypeExplainer.classList.toggle('active', m === 'explainer');
  const btnTypeMaster = document.getElementById('btnTypeMaster');
  if (btnTypeMaster) btnTypeMaster.classList.toggle('active', m === 'master');

  if (musicSetupGroup) musicSetupGroup.style.display = (m === 'music') ? 'block' : 'none';
  if (explainerConfigSection) explainerConfigSection.style.display = (m === 'explainer') ? 'block' : 'none';
  if (m === 'explainer') renderExplainerBrief();

  // Master mode is a single-panel tool: hide the wizard entirely
  const masterSection = document.getElementById('masterSection');
  if (masterSection) masterSection.style.display = (m === 'master') ? 'block' : 'none';
  const stepper = document.getElementById('stepperNav');
  if (stepper) stepper.style.display = (m === 'master') ? 'none' : 'flex';
  stepPanels.forEach((panel, idx) => {
    if (panel) panel.classList.toggle('active', m !== 'master' && idx + 1 === state.step);
  });

  const trackLyricsLabel = document.getElementById('trackLyricsLabel');
  if (trackLyricsLabel) trackLyricsLabel.innerText = (m === 'music') ? 'Lyrics' : 'Narration';
}

function setProjectType(newType) {
  if (state.mode === newType) return;
  const previous = state.mode;
  state.mode = newType;

  pauseNLEPlayback();
  stopScenePreview();
  stopAuditions();

  // Master is a non-destructive tool: entering/leaving it never touches project data
  if (newType === 'master') {
    state.lastContentMode = previous;
    applyProjectTypeUI();
    renderMasterUI();
    scheduleProjectSave();
    return;
  }
  if (previous === 'master' && newType === (state.lastContentMode || 'music')) {
    applyProjectTypeUI();
    scheduleProjectSave();
    return;
  }

  // Real content-type switch: reset content that belongs to the other type
  state.narrationAudio = null;
  state.timedLyrics = null;
  updateVoiceoverStatus();

  if (newType === 'music') {
    storyboardDesc.innerText = "Edit prompts for each scene. Animate the chosen character through the story.";
    resetToDefaultScenes();
    updateStoryboardPrompts();
  } else {
    storyboardDesc.innerText = "AI-planned scenes from your prompt. Edit visuals and narration, then generate each scene.";
    state.scenes = [];
  }

  applyProjectTypeUI();
  renderStoryboard();
  checkCompileEligibility();
  renderNLETimeline();
  goToStep(1);
}

// Navigate the wizard steps
function goToStep(stepNum) {
  if (state.step === 3 && stepNum !== 3) {
    pauseNLEPlayback(); // don't leave hidden audio playing
  }
  if (state.step === 2 && stepNum !== 2) {
    stopScenePreview(); // don't leave a song segment playing
  }
  state.step = stepNum;

  stepperButtons.forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.step, 10) === stepNum);
    btn.classList.toggle('done', parseInt(btn.dataset.step, 10) < stepNum);
  });
  stepPanels.forEach((panel, idx) => {
    if (panel) panel.classList.toggle('active', idx + 1 === stepNum);
  });

  if (stepNum === 3) {
    renderNLETimeline();
    renderSubtitleEditor();
  }
  if (stepNum === 4) {
    updatePackageStatus();
    renderThumbGrid();
    renderLangPicker();
    renderLocalizations();
    refreshChapterUI();
    renderShortsGrid();
    refreshYouTubeStatus();
    preparePublishStep();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  scheduleProjectSave();
}

async function preparePublishStep() {
  const kit = state.lastSEOKit;
  const hasCurrentCardPackage = kit && kit.introCardTitle && kit.introCardSubtitle &&
    kit.outroCardTitle && kit.outroCardCTA && kit.introBackgroundPrompt && kit.outroBackgroundPrompt;

  if (hasCurrentCardPackage) {
    if (seoResults && !seoResults.childElementCount) renderSEOKit(kit);
    applyAICardPackage(kit);
    return;
  }

  const topic = state.explainer && state.explainer.topic;
  const lyrics = lyricsInput && lyricsInput.value.trim();
  if (topic || lyrics) await generateSEOKit({ silent: true });
}


// Reset to default 4 standard scenes
function resetToDefaultScenes() {
  state.scenes = Array(4).fill(null).map((_, i) => ({
    index: i,
    start: null,
    end: null,
    prompt: '',
    generatedUrl: null,
    filename: null,
    generating: false
  }));
}

// Fetch Presets from Express Backend
async function loadPresets() {
  try {
    const res = await fetch('/api/presets');
    if (!res.ok) throw new Error("Failed to load presets");
    state.presets = await res.json();
    renderPresets();
  } catch (error) {
    console.error(error);
    showToast("Error loading characters from server", "error");
  }
}

// Render Preset Cards
function renderPresets() {
  presetsGrid.innerHTML = '';
  if (!state.presets || !state.presets.characters) return;

  state.presets.characters.forEach(char => {
    const card = document.createElement('div');
    card.className = 'character-card';
    card.dataset.id = char.id;
    card.innerHTML = `
      <img src="${char.file}" alt="${char.name}">
      <span>${char.name}</span>
    `;

    card.addEventListener('click', () => selectPresetCharacter(char));
    presetsGrid.appendChild(card);
  });

  // Default to first preset
  if (state.presets.characters.length > 0) {
    selectPresetCharacter(state.presets.characters[0]);
  }
}

// Select a Preset Character
async function selectPresetCharacter(char) {
  state.activeCharacter = {
    type: 'preset',
    name: char.name,
    fileUrl: char.file
  };

  document.querySelectorAll('.character-card').forEach(c => {
    c.classList.toggle('active', c.dataset.id === char.id);
  });

  uploadPreviewContainer.style.display = 'none';
  dropZone.style.display = 'flex';
  fileInput.value = '';

  updateStoryboardPrompts();
  scheduleProjectSave();
}

// Character File Selection Handlers
function handleFileSelect(e) {
  if (e.target.files.length > 0) {
    processFile(e.target.files[0]);
  }
}

function processFile(file) {
  if (!file.type.startsWith('image/')) {
    showToast("Please upload an image file.", "error");
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64Data = e.target.result;
    
    state.activeCharacter = {
      type: 'custom',
      name: 'My Character',
      data: base64Data,
      mimeType: file.type,
      views: null
    };

    document.querySelectorAll('.character-card').forEach(c => c.classList.remove('active'));
    
    uploadPreview.src = base64Data;
    uploadPreviewContainer.style.display = 'flex';
    dropZone.style.display = 'none';

    // Hide views section initially
    document.getElementById('characterViewsSection').style.display = 'none';
    document.getElementById('characterViewsGallery').innerHTML = '';

    showToast("Custom character uploaded! Animating 360° views...", "info");
    
    try {
      const res = await fetch('/api/generate-turnaround', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          imageBase64: base64Data,
          mimeType: file.type
        })
      });
      
      if (!res.ok) throw new Error("Turnaround generation failed");
      const data = await res.json();
      
      if (data.success && data.views) {
        state.activeCharacter.views = data.views;
        
        // Show views section
        const viewsSection = document.getElementById('characterViewsSection');
        const viewsGallery = document.getElementById('characterViewsGallery');
        viewsGallery.innerHTML = '';
        
        const labels = ['Front', 'Side', 'Back'];
        data.views.forEach((view, idx) => {
          const item = document.createElement('div');
          item.className = 'character-view-item';
          item.innerHTML = `
            <img src="${view}" alt="${labels[idx]} view">
            <span class="character-view-label">${labels[idx]}</span>
          `;
          viewsGallery.appendChild(item);
        });
        
        viewsSection.style.display = 'block';
        showToast("Extracted front, side, and back views for high-coherence generation!", "success");
      }
    } catch (err) {
      console.error(err);
      showToast("Could not generate 360° views. Coherence will fall back to single view.", "warning");
    }

    updateStoryboardPrompts();
  };
  reader.readAsDataURL(file);
}

function removeCustomUpload() {
  state.activeCharacter = null;
  uploadPreviewContainer.style.display = 'none';
  dropZone.style.display = 'flex';
  fileInput.value = '';

  if (state.presets && state.presets.characters.length > 0) {
    selectPresetCharacter(state.presets.characters[0]);
  }
}

// Audio File Selection Handlers
function handleAudioSelect(e) {
  if (e.target.files.length > 0) {
    processAudioFile(e.target.files[0]);
  }
}

async function processAudioFile(file) {
  if (!file.type.startsWith('audio/')) {
    showToast("Please upload an audio file.", "error");
    return;
  }

  showToast("Uploading audio file...", "info");
  audioDropText.innerText = "Uploading...";

  const formData = new FormData();
  formData.append('audio', file);

  try {
    const res = await fetch('/api/upload-audio', {
      method: 'POST',
      body: formData
    });

    if (!res.ok) throw new Error("Failed to upload audio file");

    const data = await res.json();
    state.audio = {
      filename: data.filename,
      duration: Math.round(data.duration * 10) / 10 // Round to 1 decimal place
    };

    // UI Updates
    audioFilenameText.innerText = file.name;
    audioDurationText.innerText = `Duration: ${state.audio.duration}s`;
    audioPreviewContainer.style.display = 'flex';
    audioDropZone.style.display = 'none';

    const dlMain = document.getElementById('btnDownloadAudio');
    if (dlMain) {
      dlMain.href = `/outputs/${data.filename}`;
      dlMain.download = data.filename;
    }

    // Feed the synced NLE preview: load audio element + decode real waveform
    const audioEl = document.getElementById('nleAudioElement');
    if (audioEl) audioEl.src = `/outputs/${data.filename}`;
    nleState.waveformPeaks = null;
    loadWaveformPeaks(data.filename);
    renderNLETimeline();

    showToast("Audio track uploaded and parsed successfully!", "success");
  } catch (error) {
    console.error(error);
    showToast("Error uploading audio file", "error");
    audioDropText.innerHTML = `Drag & drop MP3/WAV here or <span class="browse-link">browse</span>`;
  }
}

function removeAudioFile() {
  state.audio = null;
  state.timedLyrics = null;
  nleState.waveformPeaks = null;
  const audioEl = document.getElementById('nleAudioElement');
  if (audioEl) {
    audioEl.pause();
    audioEl.removeAttribute('src');
  }
  audioPreviewContainer.style.display = 'none';
  audioDropZone.style.display = 'flex';
  audioFileInput.value = '';
  audioDropText.innerHTML = `Drag & drop MP3/WAV here or <span class="browse-link">browse</span>`;
  renderNLETimeline();
}

// Generate AI Script Timings & Prompts using Gemini 2.5 Flash
async function generateAIScript() {
  if (!state.audio) {
    showToast("Please upload a music track first.", "warning");
    return;
  }

  if (!state.activeCharacter) {
    showToast("Please choose a character first.", "warning");
    return;
  }

  const autoTranscribe = chkAutoTranscribe.checked;
  const lyricsText = autoTranscribe ? "" : lyricsInput.value.trim();

  if (!autoTranscribe && !lyricsText) {
    showToast("Please enter song lyrics first, or check the 'Auto-transcribe' toggle.", "warning");
    return;
  }

  const isTranscribing = autoTranscribe;
  showToast(isTranscribing ? "Gemini is listening to your audio track and transcribing lyrics..." : "Consulting Gemini to plan storyboard timeline...", "info");
  btnGenerateScript.disabled = true;
  btnGenerateScript.innerText = isTranscribing ? "Transcribing & Generating..." : "Generating Timings...";

  try {
    const payload = {
      lyrics: autoTranscribe ? null : lyricsText,
      audioFilename: state.audio.filename,
      characterName: state.activeCharacter.name,
      durationSeconds: state.audio.duration
    };

    const res = await fetch('/api/generate-script', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to generate AI script");
    }

    const data = await res.json();

    if (!data.scenes || !Array.isArray(data.scenes)) {
      throw new Error("Invalid response format from server script generator");
    }

    // Auto-populate transcribed lyrics back into UI if returned
    if (data.transcribedLyrics) {
      lyricsInput.value = data.transcribedLyrics;
    }

    // Map output to state scenes dynamically allocating the array size
    state.scenes = data.scenes.map((scene, i) => ({
      index: i,
      start: scene.start,
      end: scene.end,
      prompt: scene.prompt,
      newBackground: scene.newBackground,
      generatedUrl: null,
      filename: null,
      interactionId: null,
      generating: false
    }));

    state.narrationAudio = null; // script changed — any old voiceover is stale
    updateVoiceoverStatus();
    renderStoryboard();
    checkCompileEligibility();
    renderNLETimeline();
    goToStep(2);
    showToast(isTranscribing ? "Audio transcribed! Review your storyboard scenes." : "AI Timeline Script generated! Review your storyboard scenes.", "success");

    // Automatically generate AI background art for Intro & Outro cards
    generateCardBackground('intro').catch(err => console.warn("Auto intro card background failed:", err));
    generateCardBackground('outro').catch(err => console.warn("Auto outro card background failed:", err));

  } catch (error) {
    console.error(error);
    showToast(`Failed to generate timeline script: ${error.message}`, "error");
  } finally {
    btnGenerateScript.disabled = false;
    btnGenerateScript.innerText = "Generate Script with AI";
  }
}

// Generate a full explainer/generic video plan from a single prompt
async function generateExplainerPlan() {
  const topic = explainerTopicInput.value.trim();
  if (!topic) {
    showToast("Please describe the video you want first.", "warning");
    return;
  }

  const durationSeconds = parseInt(explainerDuration.value, 10) || 60;
  // Pick up any edits the user made in the brief review panel
  state.pendingBrief = readBriefFromPanel();

  btnGenerateExplainerPlan.disabled = true;
  btnGenerateExplainerPlan.innerText = "Planning Scenes & Narration...";
  showToast("Gemini is planning your video scenes and narration...", "info");

  try {
    const res = await fetch('/api/generate-explainer-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: topic,
        durationSeconds: durationSeconds,
        style: explainerStyle.value,
        brief: state.pendingBrief || null
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to generate video plan");
    }

    const data = await res.json();
    if (!data.scenes || !Array.isArray(data.scenes)) {
      throw new Error("Invalid response format from server plan generator");
    }

    state.explainer = { topic, videoTitle: data.videoTitle, durationSeconds, musicPrompt: data.musicPrompt };

    // Auto-populate the Intro & Outro title cards with the video title context
    if (nleIntroTitle && (data.videoTitle || topic)) {
      nleIntroTitle.value = data.videoTitle || topic;
    }
    if (nleIntroSubtitle) {
      nleIntroSubtitle.value = "Official Video";
    }
    if (nleOutroCTA) {
      nleOutroCTA.value = "Subscribe & Comment Below for More!";
    }

    // Pre-fill the background music prompt with the plan's auto-matched mood
    if (musicPromptInput && data.musicPrompt && (!musicMoodSelect || !musicMoodSelect.value)) {
      musicPromptInput.value = data.musicPrompt;
    }

    state.scenes = data.scenes.map((scene, i) => ({
      index: i,
      start: scene.start,
      end: scene.end,
      prompt: scene.prompt,
      narration: scene.narration,
      newBackground: scene.newBackground,
      generatedUrl: null,
      filename: null,
      interactionId: null,
      generating: false
    }));

    state.narrationAudio = null; // plan changed — any old voiceover is stale
    updateVoiceoverStatus();
    renderStoryboard();
    checkCompileEligibility();
    renderNLETimeline();
    goToStep(2);
    showToast(`Video plan ready: "${data.videoTitle}" — ${state.scenes.length} scenes. Generate them below!`, "success");

    // Automatically generate AI background art for Intro & Outro cards
    generateCardBackground('intro').catch(err => console.warn("Auto intro card background failed:", err));
    generateCardBackground('outro').catch(err => console.warn("Auto outro card background failed:", err));
  } catch (error) {
    console.error(error);
    showToast(`Failed to generate video plan: ${error.message}`, "error");
  } finally {
    btnGenerateExplainerPlan.disabled = false;
    btnGenerateExplainerPlan.innerText = "Generate Video Plan with AI";
  }
}

// Generate the YouTube SEO & monetization kit
async function generateSEOKit(options = {}) {
  const topic = state.explainer ? state.explainer.topic : null;
  const lyrics = lyricsInput ? lyricsInput.value.trim() : '';

  if (!topic && !lyrics) {
    showToast("Generate a video plan or add lyrics first so SEO can be tailored.", "warning");
    return;
  }

  const totalDuration = getNLEContentDuration();

  btnGenerateSEO.disabled = true;
  btnGenerateSEO.innerText = "Building SEO Kit...";

  try {
    const res = await fetch('/api/generate-seo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: topic,
        lyrics: topic ? null : lyrics,
        durationSeconds: totalDuration,
        sceneCount: state.scenes.length || 6,
        videoType: state.mode === 'explainer' ? 'explainer' : "children's music",
        scenePrompts: state.scenes.map(s => s.prompt).filter(Boolean).slice(0, 20)
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to generate SEO kit");
    }

    const data = await res.json();
    renderSEOKit(data);
    applyAICardPackage(data);
    if (!options.silent) {
      showToast("YouTube SEO Kit and contextual cards ready!", "success");
      seoResults.scrollIntoView({ behavior: 'smooth' });
    }
    return data;
  } catch (error) {
    console.error(error);
    showToast(`Failed to generate SEO kit: ${error.message}`, "error");
    return null;
  } finally {
    btnGenerateSEO.disabled = false;
    btnGenerateSEO.innerText = "Generate YouTube SEO Kit";
  }
}

// Render the SEO kit results panel
function renderSEOKit(kit) {
  state.lastSEOKit = kit;
  scheduleProjectSave();
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Chapters: pair AI chapter titles with the scene start timestamps
  const chapters = (kit.chapterTitles || []).map((title, i) => {
    const scene = state.scenes[i];
    const stamp = scene && scene.start ? scene.start : '00:00';
    return `${i === 0 ? '00:00' : stamp} ${title}`;
  });

  seoResults.innerHTML = `
    <div class="seo-block">
      <div class="seo-block-header"><h3>Title Options</h3></div>
      ${(kit.titles || []).map(t => `
        <div class="seo-copy-row">
          <span class="seo-copy-text">${esc(t)}</span>
          <button class="btn btn-secondary btn-sm seo-copy-btn" data-copy="${esc(t)}">Copy</button>
        </div>`).join('')}
    </div>

    <div class="seo-block">
      <div class="seo-block-header">
        <h3>Description</h3>
        <button class="btn btn-secondary btn-sm seo-copy-btn" data-copy-id="seoDescriptionText">Copy All</button>
      </div>
      <pre class="seo-pre" id="seoDescriptionText">${esc(kit.description)}</pre>
    </div>

    <div class="seo-block">
      <div class="seo-block-header">
        <h3>Tags</h3>
        <button class="btn btn-secondary btn-sm seo-copy-btn" data-copy="${esc((kit.tags || []).join(', '))}">Copy All</button>
      </div>
      <div class="seo-tags">${(kit.tags || []).map(t => `<span class="seo-tag">${esc(t)}</span>`).join('')}</div>
    </div>

    <div class="seo-block">
      <div class="seo-block-header">
        <h3>Hashtags</h3>
        <button class="btn btn-secondary btn-sm seo-copy-btn" data-copy="${esc((kit.hashtags || []).join(' '))}">Copy</button>
      </div>
      <div class="seo-tags">${(kit.hashtags || []).map(t => `<span class="seo-tag seo-hashtag">${esc(t)}</span>`).join('')}</div>
    </div>

    <div class="seo-block">
      <div class="seo-block-header">
        <h3>Chapters (paste into description)</h3>
        <button class="btn btn-secondary btn-sm seo-copy-btn" data-copy-id="seoChaptersText">Copy</button>
      </div>
      <pre class="seo-pre" id="seoChaptersText">${esc(chapters.join('\n'))}</pre>
    </div>

    <div class="seo-block">
      <div class="seo-block-header"><h3>Thumbnail Ideas</h3></div>
      <ul class="seo-list">${(kit.thumbnailIdeas || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>

    <div class="seo-block">
      <div class="seo-block-header"><h3>Engagement Plan</h3></div>
      <div class="seo-copy-row">
        <span class="seo-copy-text"><strong>Opening hook:</strong> ${esc(kit.openingHook)}</span>
        <button class="btn btn-secondary btn-sm seo-copy-btn" data-copy="${esc(kit.openingHook)}">Copy</button>
      </div>
      <div class="seo-copy-row">
        <span class="seo-copy-text"><strong>Pinned comment:</strong> ${esc(kit.pinnedComment)}</span>
        <button class="btn btn-secondary btn-sm seo-copy-btn" data-copy="${esc(kit.pinnedComment)}">Copy</button>
      </div>
      <div class="seo-copy-row">
        <span class="seo-copy-text"><strong>End-screen bridge:</strong> ${esc(kit.endScreenBridge)}</span>
        <button class="btn btn-secondary btn-sm seo-copy-btn" data-copy="${esc(kit.endScreenBridge)}">Copy</button>
      </div>
      <h4>Short-form hooks</h4>
      ${(kit.shortsHooks || []).map(hook => `
        <div class="seo-copy-row">
          <span class="seo-copy-text">${esc(hook)}</span>
          <button class="btn btn-secondary btn-sm seo-copy-btn" data-copy="${esc(hook)}">Copy</button>
        </div>`).join('')}
    </div>

    <div class="seo-block">
      <div class="seo-block-header"><h3>Growth & Monetization Tips</h3></div>
      <ul class="seo-list">${(kit.postingTips || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>
  `;

  // One delegated listener for all copy buttons
  seoResults.querySelectorAll('.seo-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.copyId
        ? document.getElementById(btn.dataset.copyId).innerText
        : btn.dataset.copy;
      navigator.clipboard.writeText(text)
        .then(() => showToast("Copied to clipboard!", "success"))
        .catch(() => showToast("Could not copy to clipboard", "error"));
    });
  });
}

const LEGACY_CARD_COPY_FINGERPRINTS = new Set([
  3494216071, 2577699505, 4143935888, 3509532198, 2294055317, 3394385793,
  2698769059
]);

function isLegacyCardCopy(value) {
  let fingerprint = 2166136261;
  for (const char of value) {
    fingerprint ^= char.charCodeAt(0);
    fingerprint = Math.imul(fingerprint, 16777619);
  }
  return LEGACY_CARD_COPY_FINGERPRINTS.has(fingerprint >>> 0);
}

function migratePersistedCardCopy(inputs, kit) {
  const migrated = { ...inputs };
  const ids = ['nleIntroTitle', 'nleIntroSubtitle', 'nleOutroTitle', 'nleOutroCTA'];
  const hasLegacyCopy = ids.some(id => isLegacyCardCopy(String(migrated[id] || '').trim()));
  if (!hasLegacyCopy) return { inputs: migrated, changed: false };

  const replacements = {
    nleIntroTitle: kit && kit.introCardTitle,
    nleIntroSubtitle: kit && kit.introCardSubtitle,
    nleOutroTitle: kit && kit.outroCardTitle,
    nleOutroCTA: kit && (kit.outroCardCTA || kit.endScreenBridge)
  };
  ids.forEach(id => { migrated[id] = String(replacements[id] || '').trim(); });
  return { inputs: migrated, changed: true };
}

function applyAICardPackage(kit) {
  if (!kit) return;
  const fields = [
    [nleIntroTitle, kit.introCardTitle],
    [nleIntroSubtitle, kit.introCardSubtitle],
    [nleOutroTitle, kit.outroCardTitle],
    [nleOutroCTA, kit.outroCardCTA || kit.endScreenBridge]
  ];
  fields.forEach(([element, generated]) => {
    if (!element || !String(generated || '').trim()) return;
    const current = element.value.trim();
    if (!current || isLegacyCardCopy(current)) element.value = generated.trim();
  });
  updateTitleCardOverlay(nleState.currentTime);
  scheduleProjectSave();
}

// Convert Image URL to Base64
async function urlToBase64(url) {
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Update Storyboard Input Prompts
function updateStoryboardPrompts() {
  // Explainer prompts come from the AI plan; AI-timed music scenes keep their script prompts
  if (state.mode !== 'music') return;

  if (!state.presets || !state.activeCharacter) return;

  state.scenes.forEach((scene, index) => {
    if (scene.start !== null) return; // AI script scene — don't overwrite with preset prompt
    if (index >= state.presets.scenePrompts.length) return;
    const charName = state.activeCharacter.name;
    const basePrompt = state.presets.scenePrompts[index];
    const fullPrompt = `${charName} ${basePrompt}`;
    
    scene.prompt = fullPrompt;

    const input = document.getElementById(`scene-input-${index}`);
    if (input && !scene.generatedUrl) {
      input.value = fullPrompt;
    }
  });
}

// Helper to compute durations from MM:SS strings
function timeToSeconds(timeStr) {
  if (!timeStr) return 10.0;
  const parts = timeStr.split(':');
  const minutes = parseInt(parts[0], 10);
  const seconds = parseFloat(parts[1]);
  return minutes * 60 + seconds;
}

// Lyric lines that fall inside a scene's time window
function getSegmentLyrics(scene) {
  const s = timeToSeconds(scene.start);
  const e = timeToSeconds(scene.end);
  return getLyricsBlocks()
    .filter(l => l.startTime < e && (l.startTime + l.duration) > s)
    .map(l => l.text);
}

/* --------------- Per-scene song segment preview --------------- */

let scenePreviewAudio = null;
let scenePreviewState = { index: null, endSec: 0 };

function toggleScenePreview(index) {
  const scene = state.scenes[index];
  if (!state.audio) {
    showToast("Add a song first (upload or generate with Lyria).", "warning");
    return;
  }
  if (!scene || !scene.start || !scene.end) {
    showToast("This scene has no timing yet — generate the AI script first.", "warning");
    return;
  }

  // Toggle off if this scene is already playing
  if (scenePreviewState.index === index) {
    stopScenePreview();
    return;
  }

  stopScenePreview();
  pauseNLEPlayback();
  stopAuditions();

  if (!scenePreviewAudio) {
    scenePreviewAudio = new Audio();
    scenePreviewAudio.addEventListener('timeupdate', () => {
      if (scenePreviewState.index !== null && scenePreviewAudio.currentTime >= scenePreviewState.endSec - 0.03) {
        stopScenePreview();
      }
    });
    scenePreviewAudio.addEventListener('ended', stopScenePreview);
  }

  const startSec = timeToSeconds(scene.start);
  const endSec = timeToSeconds(scene.end);
  const src = `/outputs/${state.audio.filename}`;

  const seekAndPlay = () => {
    scenePreviewAudio.currentTime = startSec;
    scenePreviewAudio.play().catch(() => {});
    // Restart the generated clip so visuals and song segment start together
    const vid = document.querySelector(`#video-slot-${index} video`);
    if (vid) {
      vid.currentTime = 0;
      vid.play().catch(() => {});
    }
  };

  scenePreviewState = { index, endSec };
  if (scenePreviewAudio.src.endsWith(src) && scenePreviewAudio.readyState >= 1) {
    seekAndPlay();
  } else {
    scenePreviewAudio.src = src;
    scenePreviewAudio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
  }
  updateListenButtons();
}

function stopScenePreview() {
  if (scenePreviewAudio && !scenePreviewAudio.paused) scenePreviewAudio.pause();
  scenePreviewState = { index: null, endSec: 0 };
  updateListenButtons();
}

function updateListenButtons() {
  document.querySelectorAll('[data-listen]').forEach(btn => {
    const active = scenePreviewState.index === parseInt(btn.dataset.listen, 10);
    btn.classList.toggle('playing', active);
    btn.innerText = active ? '■ Stop' : btn.dataset.label;
  });
}

// Render Storyboard Grid
function renderStoryboard() {
  storyboardGrid.innerHTML = '';

  state.scenes.forEach((scene, index) => {
    const card = document.createElement('div');
    card.className = 'scene-card';
    card.id = `scene-card-${index}`;

    // Compute duration text if scene has AI-planned timings
    let timingHeader = '';
    if (scene.start && scene.end) {
      const duration = Math.round((timeToSeconds(scene.end) - timeToSeconds(scene.start)) * 10) / 10;
      timingHeader = `
        <span class="scene-time-badge">
          ⏱️ ${scene.start} - ${scene.end} (${duration}s)
        </span>
      `;
    }

    // Song segment context: listen button + the lyric lines sung during this scene
    const hasSegment = !!(state.audio && scene.start && scene.end);
    const segLyrics = (state.mode === 'music' && scene.start && scene.end) ? getSegmentLyrics(scene) : [];
    const listenBlock = hasSegment ? `
      <div class="scene-listen-row">
        <button type="button" class="btn btn-secondary btn-sm listen-btn" data-listen="${index}"
                data-label="▶ Hear song ${scene.start}–${scene.end}">▶ Hear song ${scene.start}–${scene.end}</button>
        <span class="listen-hint">plays this scene's slice of the track${scene.generatedUrl ? ', clip restarts in sync' : ''}</span>
      </div>` : '';
    const segLyricsBlock = segLyrics.length ? `
      <div class="segment-lyrics" title="Lyrics sung during this scene — make the prompt act them out">
        ${segLyrics.map(t => `<span class="seg-line">🎵 ${escapeHtml(t)}</span>`).join('')}
      </div>` : '';

    card.innerHTML = `
      <div class="scene-header-bar">
        <div class="scene-title">
          <span class="scene-number">Scene ${index + 1}</span>
          ${timingHeader}
        </div>
        <span class="scene-status pending" id="scene-status-${index}">Empty</span>
      </div>
      ${listenBlock}
      ${segLyricsBlock}
      <div class="prompt-wrapper">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem;">
          <label for="scene-input-${index}">Scene Prompt</label>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-enhance-${index}" onclick="enhanceScenePrompt(${index})" style="font-size: 0.75rem; padding: 0.2rem 0.5rem; background: rgba(139, 92, 246, 0.15); border-color: rgba(139, 92, 246, 0.4); color: #c4b5fd;">✨ Enhance (Omni Guide)</button>
        </div>
        <textarea 
          class="scene-input" 
          id="scene-input-${index}" 
          placeholder="Describe the action..."
        >${scene.prompt || ''}</textarea>
      </div>

      ${scene.narration ? `<div class="scene-narration">Narration: ${scene.narration}</div>` : ''}
      ${scene.coherenceRevised ? `<div class="coherence-note" title="${(scene.coherenceIssue || '').replace(/"/g, '&quot;')}">Continuity agent revised this prompt${scene.coherenceIssue ? `: ${scene.coherenceIssue}` : ''}</div>` : ''}

      <div class="video-slot" id="video-slot-${index}">
        <div class="video-placeholder">
          <span class="video-placeholder-icon">▦</span>
          <span>No video generated yet</span>
        </div>
      </div>

      <div class="scene-source-actions">
        <button class="btn btn-secondary" id="btn-generate-${index}" onclick="generateScene(${index})">
          Generate Scene
        </button>
        <button class="btn btn-secondary" data-stock="${index}">Stock clip</button>
      </div>
      <div class="stock-picker" id="stock-picker-${index}" style="display: none;"></div>
    `;

    storyboardGrid.appendChild(card);
    updateSceneUI(index);
    if (scene.realism || scene.realismChecking) updateSceneRealismUI(index);
  });
}

// Enhance a scene prompt following DeepMind Gemini Omni Prompt Guide
async function enhanceScenePrompt(index) {
  const scene = state.scenes[index];
  const inputElement = document.getElementById(`scene-input-${index}`);
  const promptText = inputElement ? inputElement.value.trim() : (scene.prompt || '');

  if (!promptText) {
    showToast("Please enter a scene prompt first.", "warning");
    return;
  }

  const btn = document.getElementById(`btn-enhance-${index}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="loading-spinner"></span> Enhancing...`;
  }

  try {
    // Check if this scene is a continuation of the previous scene
    let previousPrompt = '';
    let isContinuation = false;
    if (index > 0 && scene.newBackground === false) {
      const prevScene = state.scenes[index - 1];
      if (prevScene) {
        previousPrompt = prevScene.prompt || '';
        isContinuation = true;
      }
    }

    const res = await fetch('/api/enhance-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: promptText,
        characterName: state.activeCharacter ? state.activeCharacter.name : '',
        style: state.explainer ? state.explainer.style : '3D claymation animation style',
        isContinuation: isContinuation,
        previousPrompt: previousPrompt
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to enhance prompt");
    }

    const data = await res.json();
    scene.prompt = data.enhancedPrompt;
    if (inputElement) inputElement.value = data.enhancedPrompt;

    showToast(`Scene ${index + 1} prompt enhanced via DeepMind Omni Guide!`, "success");
  } catch (error) {
    console.error(error);
    showToast(`Prompt enhancement failed: ${error.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `✨ Enhance (Omni Guide)`;
    }
  }
}
window.enhanceScenePrompt = enhanceScenePrompt;


// Generate Individual Scene Video
async function generateScene(index) {
  const scene = state.scenes[index];
  const inputElement = document.getElementById(`scene-input-${index}`);
  const promptText = inputElement.value.trim();

  if (!promptText) {
    showToast("Please enter a scene prompt.", "warning");
    return;
  }

  // Explainer mode needs no character — scenes generate from text prompts alone
  const isExplainer = state.mode === 'explainer';
  if (!isExplainer && !state.activeCharacter) {
    showToast("Please choose a character first.", "warning");
    return;
  }

  scene.generating = true;
  updateSceneUI(index);

  try {
    let imageBase64 = null;
    let mimeType = 'image/png';
    let images = null;
    let characterName = null;

    if (!isExplainer) {
      characterName = state.activeCharacter.name;
      // Gather all style references (channel brand, project brand, active character)
      images = await collectStyleRefs();
    }

    // Background continuity: chain on the previous interaction when possible, and
    // ALWAYS pass the previous scene's file so the server can seed the new scene
    // with its final frame (works even when chaining fails or isn't available).
    let previousInteractionId = null;
    let previousSceneFilename = null;
    if (index > 0 && scene.newBackground === false) {
      const prevScene = state.scenes[index - 1];
      if (prevScene && prevScene.interactionId) {
        previousInteractionId = prevScene.interactionId;
      }
      if (prevScene && prevScene.filename && prevScene.generatedUrl) {
        previousSceneFilename = prevScene.filename;
      }
    }

    const payload = {
      imageBase64: imageBase64,
      images: images,
      mimeType: mimeType,
      characterName: characterName,
      sceneDescription: promptText,
      sceneIndex: index,
      previousInteractionId: previousInteractionId,
      previousSceneFilename: previousSceneFilename,
      aspectRatio: state.orientation === 'vertical' ? '9:16' : '16:9'
    };

    const res = await fetch('/api/generate-scene', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to generate video");
    }

    const data = await res.json();
    
    scene.generatedUrl = data.videoUrl;
    scene.filename = data.filename;
    scene.interactionId = data.interactionId;
    scene.prompt = promptText;
    
    showToast(`Scene ${index + 1} generated successfully!`, "success");

  } catch (error) {
    console.error(error);
    showToast(`Failed to generate Scene ${index + 1}: ${error.message}`, "error");
  } finally {
    scene.generating = false;
    updateSceneUI(index);
    checkCompileEligibility();
    renderNLETimeline();
  }
}

// Update Scene UI Elements
function updateSceneUI(index) {
  const scene = state.scenes[index];
  const card = document.getElementById(`scene-card-${index}`);
  if (!card) return;

  const statusBadge = document.getElementById(`scene-status-${index}`);
  const videoSlot = document.getElementById(`video-slot-${index}`);
  const btnGenerate = document.getElementById(`btn-generate-${index}`);

  if (scene.generating) {
    statusBadge.className = 'scene-status pending';
    statusBadge.innerText = 'Generating...';
    btnGenerate.disabled = true;
    
    videoSlot.innerHTML = `
      <div class="loading-overlay">
        <div class="spinner"></div>
        <div class="loading-text">Animating Scene...</div>
      </div>
    `;
  } else if (scene.generatedUrl) {
    statusBadge.className = 'scene-status ready';
    statusBadge.innerText = 'Ready';
    btnGenerate.disabled = false;
    btnGenerate.innerText = 'Re-generate Scene';

    videoSlot.className = 'video-slot has-content';
    videoSlot.innerHTML = `
      <video src="${scene.generatedUrl}" controls autoplay loop muted></video>
    `;
  } else {
    statusBadge.className = 'scene-status pending';
    statusBadge.innerText = 'Empty';
    btnGenerate.disabled = false;
    btnGenerate.innerText = 'Generate Scene';

    videoSlot.className = 'video-slot';
    videoSlot.innerHTML = `
      <div class="video-placeholder">
        <span class="video-placeholder-icon">▦</span>
        <span>No video generated yet</span>
      </div>
    `;
  }

  updateSceneRefineUI(index);
}

// Conversational editing controls under a generated clip (Interactions API multi-turn)
function updateSceneRefineUI(index) {
  const scene = state.scenes[index];
  const card = document.getElementById(`scene-card-${index}`);
  if (!card) return;

  let box = card.querySelector('.refine-box');
  if (!scene.generatedUrl || scene.generating) {
    if (box) box.remove();
    return;
  }

  if (!box) {
    box = document.createElement('div');
    box.className = 'refine-box';
    const videoSlot = document.getElementById(`video-slot-${index}`);
    videoSlot.parentNode.insertBefore(box, videoSlot.nextSibling);
  }

  const canRefine = !!scene.interactionId;
  box.innerHTML = `
    <input type="text" class="text-input refine-input" id="refine-input-${index}" data-refine-input="${index}"
           placeholder='${canRefine ? 'Edit with AI, e.g. "make the sky purple at dusk"' : 'Re-generate this scene once to enable AI editing'}'
           ${canRefine ? '' : 'disabled'}>
    <button class="btn btn-secondary btn-sm" id="refine-btn-${index}" data-refine="${index}" ${canRefine ? '' : 'disabled'}>Refine</button>
  `;
  // Click/Enter handled by delegated listeners on the storyboard grid (survive re-renders)
}

/* --------------- Free stock video (b-roll) per scene --------------- */

// A short search keyword from the scene's narration/prompt
function stockKeywordFor(scene) {
  const src = (scene.narration || scene.prompt || '').replace(/3D claymation style|animated explainer style|,.*$/i, '');
  return src.split(/\s+/).filter(w => w.length > 3).slice(0, 4).join(' ').trim() || 'technology';
}

function toggleStockPicker(index) {
  const picker = document.getElementById(`stock-picker-${index}`);
  if (!picker) return;
  if (picker.style.display !== 'none') { picker.style.display = 'none'; return; }
  picker.style.display = 'block';
  picker.innerHTML = `
    <div class="stock-search-row">
      <input type="text" class="text-input" id="stock-q-${index}" value="${escapeHtml(stockKeywordFor(state.scenes[index]))}" placeholder="Search free stock footage…">
      <button class="btn btn-secondary btn-sm" data-stock-search="${index}">Search</button>
    </div>
    <div class="stock-grid" id="stock-grid-${index}"></div>`;
  picker.querySelector(`[data-stock-search="${index}"]`).addEventListener('click', () => runStockSearch(index));
  picker.querySelector(`#stock-q-${index}`).addEventListener('keydown', e => { if (e.key === 'Enter') runStockSearch(index); });
  runStockSearch(index);
}

async function runStockSearch(index) {
  const grid = document.getElementById(`stock-grid-${index}`);
  const q = document.getElementById(`stock-q-${index}`).value.trim();
  if (!q) return;
  grid.innerHTML = '<span class="muted">Searching…</span>';
  try {
    const res = await fetch(`/api/stock/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.enabled === false) {
      grid.innerHTML = `<p class="inspector-hint">${escapeHtml(data.error)}</p>`;
      return;
    }
    if (!res.ok) throw new Error(data.error || 'search failed');
    if (!data.results.length) { grid.innerHTML = '<span class="muted">No clips found — try another keyword.</span>'; return; }
    grid.innerHTML = data.results.map((r, i) => `
      <div class="stock-item" data-stock-pick="${index}:${i}" title="${escapeHtml(r.author ? r.provider + ' · ' + r.author : r.provider)}">
        <img src="${r.thumb}" loading="lazy" alt="">
        <span class="stock-dur">${r.duration ? r.duration + 's' : ''}</span>
      </div>`).join('');
    grid._results = data.results;
    grid.querySelectorAll('[data-stock-pick]').forEach(el => el.addEventListener('click', () => {
      const [idx, i] = el.dataset.stockPick.split(':').map(Number);
      useStockClip(idx, grid._results[i]);
    }));
  } catch (err) {
    grid.innerHTML = `<span class="muted">Search failed: ${escapeHtml(err.message)}</span>`;
  }
}

async function useStockClip(index, clip) {
  const scene = state.scenes[index];
  scene.generating = true;
  updateSceneUI(index);
  showToast(`Fetching stock clip from ${clip.provider}…`, "info");
  try {
    const res = await fetch('/api/stock/use', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: clip.videoUrl, sceneIndex: index, orientation: state.orientation })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'fetch failed');
    const data = await res.json();
    scene.generatedUrl = data.videoUrl;
    scene.filename = data.filename;
    scene.interactionId = null;          // stock clips can't be AI-refined
    scene.stock = { provider: clip.provider, author: clip.author };
    scene.realism = null;
    const picker = document.getElementById(`stock-picker-${index}`);
    if (picker) picker.style.display = 'none';
    showToast(`Scene ${index + 1}: using ${clip.provider} stock footage.`, "success");
  } catch (err) {
    console.error(err);
    showToast(`Stock clip failed: ${err.message}`, "error");
  } finally {
    scene.generating = false;
    updateSceneUI(index);
    checkCompileEligibility();
    renderNLETimeline();
    scheduleProjectSave();
  }
}

// Send an edit instruction to Omni Flash chained on the scene's last interaction
async function refineScene(index) {
  const scene = state.scenes[index];
  const input = document.getElementById(`refine-input-${index}`);
  const btn = document.getElementById(`refine-btn-${index}`);
  const instruction = input ? input.value.trim() : '';

  if (!instruction) {
    showToast("Describe the change first, e.g. \"make it nighttime with fireflies\".", "warning");
    return;
  }
  if (!scene.interactionId) {
    showToast("This clip predates editing support — re-generate it once to enable refinement.", "warning");
    return;
  }

  btn.disabled = true;
  input.disabled = true;
  btn.innerText = 'Refining…';
  showToast(`Refining Scene ${index + 1}: "${instruction}"`, "info");

  try {
    const res = await fetch('/api/refine-scene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interactionId: scene.interactionId,
        instruction: instruction,
        sceneIndex: index,
        aspectRatio: state.orientation === 'vertical' ? '9:16' : '16:9'
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Refinement failed');
    }

    const data = await res.json();
    scene.generatedUrl = data.videoUrl;
    scene.filename = data.filename;
    scene.interactionId = data.interactionId || scene.interactionId;
    scene.realism = null; // the clip changed — old realism verdict is stale
    scene.refineHistory = [...(scene.refineHistory || []), instruction];

    updateSceneUI(index);
    renderNLETimeline();
    scheduleProjectSave();
    showToast(`Scene ${index + 1} refined. You can keep editing conversationally.`, "success");
  } catch (error) {
    console.error(error);
    showToast(`Refinement failed: ${error.message}`, "error");
    updateSceneUI(index);
  }
}

// Check Compile Eligibility
function checkCompileEligibility() {
  const allReady = state.scenes.every(scene => scene.generatedUrl !== null);
  
  if (btnGenerateAll) {
    btnGenerateAll.disabled = (state.scenes.length === 0);
  }
  
  if (btnCompile) btnCompile.disabled = !allReady;

  if (state.scenes.length === 0) {
    compileStatusText.innerText = state.mode === 'explainer'
      ? "Generate a video plan in Setup to populate the storyboard."
      : "Generate the AI script in Setup, or switch prompts freely below.";
    compileStatusText.style.color = "var(--color-text-muted)";
  } else if (allReady) {
    compileStatusText.innerText = "All scenes ready! Continue to Studio & Render.";
    compileStatusText.style.color = "var(--color-success)";
  } else {
    const readyCount = state.scenes.filter(scene => scene.generatedUrl !== null).length;
    compileStatusText.innerText = `Generated ${readyCount}/${state.scenes.length} scenes.`;
    compileStatusText.style.color = "var(--color-text-muted)";
  }
}

// Compile Full Music Video
async function compileMusicVideo() {
  const allReady = state.scenes.every(scene => scene.generatedUrl !== null);

  if (!allReady) {
    showToast(`Please generate all ${state.scenes.length} scenes first.`, "warning");
    return;
  }

  btnCompile.disabled = true;
  
  try {
    if (state.mode === 'sync') {
      if (!state.audio) {
        showToast("Please upload an audio track.", "warning");
        return;
      }
      
      compileStatusText.innerHTML = `<span class="loading-spinner"></span> Speed-conforming clips and merging with audio track...`;
      
      // Calculate scene durations
      const scenesPayload = state.scenes.map(scene => {
        const duration = timeToSeconds(scene.end) - timeToSeconds(scene.start);
        return {
          filename: scene.filename,
          duration: duration
        };
      });

      const res = await fetch('/api/merge-video-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          audioFilename: state.audio.filename,
          scenes: scenesPayload
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to compile synced video");
      }

      const data = await res.json();

      finalVideo.src = data.videoUrl;
      downloadLink.href = data.videoUrl;
      mergedVideoDisplay.style.display = 'block';
      
      showToast("Synced Music Video Compiled!", "success");
      mergedVideoDisplay.scrollIntoView({ behavior: 'smooth' });
      finalVideo.play();

    } else {
      // Standard compilation
      compileStatusText.innerHTML = `<span class="loading-spinner"></span> Concatenating scenes using FFmpeg...`;
      const filenames = state.scenes.map(s => s.filename).filter(Boolean);

      const res = await fetch('/api/merge-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filenames })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to merge videos");
      }

      const data = await res.json();

      finalVideo.src = data.videoUrl;
      downloadLink.href = data.videoUrl;
      mergedVideoDisplay.style.display = 'block';
      
      showToast("Full Music Video Compiled!", "success");
      sendNativeNotification('🎬 OmniStudio: Video Compiled', `Full music video compiled successfully!`);
      mergedVideoDisplay.scrollIntoView({ behavior: 'smooth' });
      finalVideo.play();
    }

  } catch (error) {
    console.error(error);
    showToast(`Failed to compile music video: ${error.message}`, "error");
    sendNativeNotification('⚠️ OmniStudio: Render Error', `Compilation failed: ${error.message}`);
  } finally {
    btnCompile.disabled = false;
    checkCompileEligibility();
  }
}

// Reset Studio to initial state
function resetStudio() {
  state.scenes.forEach(scene => {
    scene.generatedUrl = null;
    scene.filename = null;
  });

  if (state.mode === 'music') {
    resetToDefaultScenes();
    updateStoryboardPrompts();
  } else {
    state.scenes = [];
  }

  state.narrationAudio = null;
  state.timedLyrics = null;
  updateVoiceoverStatus();
  pauseNLEPlayback();

  if (chkAutoTranscribe) {
    chkAutoTranscribe.checked = false;
    handleAutoTranscribeChange();
  }

  mergedVideoDisplay.style.display = 'none';
  finalVideo.src = '';
  
  renderStoryboard();
  updateStoryboardPrompts();
  checkCompileEligibility();
  showToast("Studio restarted!", "info");
}

// Upload the finished master video to GCS
async function uploadLastRenderToGCS() {
  if (!state.lastRender || !state.lastRender.filename) {
    showToast("No rendered video found. Please render the studio video first.", "warning");
    return;
  }
  
  const btn = document.getElementById('btnUploadToGCS');
  if (btn) {
    btn.disabled = true;
    btn.innerText = "Uploading to GCS...";
  }

  showToast("Uploading video to Google Cloud Storage bucket...", "info");
  
  try {
    const res = await fetch('/api/gcs/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: state.lastRender.filename })
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "GCS upload failed");
    }
    
    const data = await res.json();
    showToast("Successfully uploaded video to Cloud Storage!", "success");
    console.log(data.message);
  } catch (err) {
    console.error(err);
    showToast(`Upload failed: ${err.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = "☁️ Upload to GCS";
    }
  }
}

// Track where sequential generation stopped so we can resume
let sequentialResumeIndex = 0;

// Generate all scenes sequentially to maintain stateful background chaining
async function generateAllScenesSequentially(startFrom) {
  if (state.scenes.length === 0) {
    showToast("Please generate the AI script timings first.", "warning");
    return;
  }

  const resumeIdx = (typeof startFrom === 'number') ? startFrom : sequentialResumeIndex;
  sequentialResumeIndex = resumeIdx;

  btnGenerateAll.disabled = true;

  // On a fresh run, let the continuity agent fix incoherent prompts BEFORE
  // spending video-generation credits on them
  if (resumeIdx === 0 && state.scenes.length >= 2) {
    btnGenerateAll.innerText = "Continuity agent reviewing prompts...";
    try {
      await runCoherenceCheck(true);
    } catch (err) {
      console.warn("Continuity review skipped:", err);
    }
  }
  btnGenerateAll.innerText = `Generating Scene ${resumeIdx + 1}/${state.scenes.length}...`;
  btnCompile.disabled = true;

  try {
    for (let i = resumeIdx; i < state.scenes.length; i++) {
      btnGenerateAll.innerText = `Generating Scene ${i + 1}/${state.scenes.length}...`;
      showToast(`Starting sequential generation for Scene ${i + 1}/${state.scenes.length}...`, "info");
      await generateScene(i);
      
      // If generation failed, stop the loop and offer resume
      if (!state.scenes[i].generatedUrl) {
        sequentialResumeIndex = i;
        throw new Error(`Scene ${i + 1} failed to generate.`);
      }
      
      // Advance resume marker past this successful scene
      sequentialResumeIndex = i + 1;
    }
    
    // All done
    sequentialResumeIndex = 0;
    showToast("All scenes generated sequentially! Background continuity maintained.", "success");
    btnGenerateAll.innerText = "Generate All Scenes";
    const projName = (projectsIndex && projectsIndex.projects[projectsIndex.currentId] && projectsIndex.projects[projectsIndex.currentId].name) || state.explainer?.topic || 'Project';
    sendNativeNotification('🎬 OmniStudio: All Scenes Generated', `All ${state.scenes.length} scene clips for "${projName}" have been generated!`);

    // Hands-off realism pass: review clips and auto-fix low-scoring ones once
    const autoRealism = document.getElementById('chkAutoRealism');
    if (autoRealism && autoRealism.checked) {
      await autoRealismPass();
      btnGenerateAll.innerText = "Generate All Scenes";
    }
  } catch (error) {
    console.error(error);
    showToast(`Sequential generation halted at Scene ${sequentialResumeIndex + 1}. Click Resume to continue.`, "error");
    btnGenerateAll.innerText = `Resume from Scene ${sequentialResumeIndex + 1}`;
    sendNativeNotification('⚠️ OmniStudio: Scene Generation Failed', `Generation halted at Scene ${sequentialResumeIndex + 1}: ${error.message}`);
  } finally {
    btnGenerateAll.disabled = false;
    checkCompileEligibility();
  }
}

// Expose handlers globally
window.generateScene = generateScene;

/* ==========================================================================
   NLE Studio Multitrack Engine (Clipchamp / Premiere Style Editor)
   ========================================================================== */

// NLE State
const nleState = {
  zoom: 1.0,
  currentTime: 0,
  totalDuration: 60,
  isPlaying: false,
  waveformPeaks: null, // decoded audio amplitude peaks for real waveform drawing
  rafId: null,
  playStartWall: 0 // performance.now() timestamp anchoring the master playback clock
};

// DOM References for NLE
const nleStudioSection = document.getElementById('nleStudioSection');
const nlePreviewVideo = document.getElementById('nlePreviewVideo');
const nleSubtitleOverlay = document.getElementById('nleSubtitleOverlay');
const nleAudioElement = document.getElementById('nleAudioElement');
const nleCardOverlay = document.getElementById('nleCardOverlay');
const btnNLEPlayPause = document.getElementById('btnNLEPlayPause');
const nleCurrentTime = document.getElementById('nleCurrentTime');
const nleTotalTime = document.getElementById('nleTotalTime');

const tabSubtitlesBtn = document.getElementById('tabSubtitlesBtn');
const tabTitleCardsBtn = document.getElementById('tabTitleCardsBtn');
const tabVoiceoverBtn = document.getElementById('tabVoiceoverBtn');
const tabSubtitlesContent = document.getElementById('tabSubtitlesContent');
const tabTitleCardsContent = document.getElementById('tabTitleCardsContent');
const tabVoiceoverContent = document.getElementById('tabVoiceoverContent');

// Voiceover DOM references
const nleNarrationElement = document.getElementById('nleNarrationElement');
const nleVoiceSelect = document.getElementById('nleVoiceSelect');
const voiceoverStatus = document.getElementById('voiceoverStatus');
const nleSpeakPreview = document.getElementById('nleSpeakPreview');

// Background Music DOM references
const tabMusicBtn = document.getElementById('tabMusicBtn');
const tabMusicContent = document.getElementById('tabMusicContent');
const musicMoodSelect = document.getElementById('musicMoodSelect');
const musicPromptInput = document.getElementById('musicPromptInput');
const musicStatus = document.getElementById('musicStatus');

const nleSubPosition = document.getElementById('nleSubPosition');
const nleSubFontSize = document.getElementById('nleSubFontSize');
const nleSubTextColor = document.getElementById('nleSubTextColor');
const nleSubStrokeColor = document.getElementById('nleSubStrokeColor');
const nleSubBgBox = document.getElementById('nleSubBgBox');

const nleIntroEnabled = document.getElementById('nleIntroEnabled');
const nleIntroTitle = document.getElementById('nleIntroTitle');
const nleIntroSubtitle = document.getElementById('nleIntroSubtitle');
const nleIntroDuration = document.getElementById('nleIntroDuration');
const nleOutroEnabled = document.getElementById('nleOutroEnabled');
const nleOutroTitle = document.getElementById('nleOutroTitle');
const nleOutroCTA = document.getElementById('nleOutroCTA');
const nleOutroDuration = document.getElementById('nleOutroDuration');

const btnNLECompileMaster = document.getElementById('btnNLECompileMaster');
const btnNLEReset = document.getElementById('btnNLEReset');
const btnZoomOut = document.getElementById('btnZoomOut');
const btnZoomIn = document.getElementById('btnZoomIn');

const timelineViewport = document.getElementById('timelineViewport');
const timelinePlayhead = document.getElementById('timelinePlayhead');
const contentTitleCards = document.getElementById('contentTitleCards');
const contentLyrics = document.getElementById('contentLyrics');
const contentScenes = document.getElementById('contentScenes');
const contentAudio = document.getElementById('contentAudio');
const waveformCanvas = document.getElementById('waveformCanvas');


// Inspector Tabs Switcher
const inspectorTabs = [
  { btn: tabSubtitlesBtn, content: tabSubtitlesContent },
  { btn: tabTitleCardsBtn, content: tabTitleCardsContent },
  { btn: tabVoiceoverBtn, content: tabVoiceoverContent },
  { btn: tabMusicBtn, content: tabMusicContent },
  { btn: document.getElementById('tabPolishBtn'), content: document.getElementById('tabPolishContent') }
];
inspectorTabs.forEach(({ btn, content }) => {
  if (!btn || !content) return;
  btn.addEventListener('click', () => {
    inspectorTabs.forEach(t => {
      if (!t.btn || !t.content) return;
      t.btn.classList.toggle('active', t.btn === btn);
      t.content.style.display = (t.btn === btn) ? 'block' : 'none';
    });
  });
});

// Format Seconds into Timecode MM:SS.SS
function formatTimecode(seconds) {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(5, '0')}`;
}

// Parse Lyric lines into timed blocks
function getLyricsBlocks() {
  // Explainer mode: narration lines are locked to their scene timings
  if (state.mode === 'explainer') {
    return state.scenes
      .filter(s => s.narration)
      .map(s => ({
        text: s.narration,
        startTime: timeToSeconds(s.start || '00:00'),
        duration: Math.max(1, timeToSeconds(s.end || '00:10') - timeToSeconds(s.start || '00:00'))
      }));
  }

  // Real transcribed line timings (from Lyria song generation or auto-transcription)
  if (state.timedLyrics && state.timedLyrics.length > 0) {
    return state.timedLyrics;
  }

  const text = lyricsInput ? lyricsInput.value.trim() : '';
  if (!text) return [];

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  // Fallback: distribute lines evenly across the track
  const totalAudioDuration = getNLEContentDuration();
  const timePerLine = totalAudioDuration / lines.length;

  return lines.map((line, idx) => ({
    text: line,
    startTime: idx * timePerLine,
    duration: timePerLine
  }));
}

// Timeline geometry helpers
function getNLEIntroDuration() {
  if (!nleIntroEnabled || !nleIntroEnabled.checked) return 0;
  const durEl = document.getElementById('nleIntroDuration');
  const dur = durEl ? parseFloat(durEl.value) : 4;
  return (isNaN(dur) || dur < 0.5) ? 4 : dur;
}

function getNLEOutroDuration() {
  if (!nleOutroEnabled || !nleOutroEnabled.checked) return 0;
  const durEl = document.getElementById('nleOutroDuration');
  const dur = durEl ? parseFloat(durEl.value) : 4;
  return (isNaN(dur) || dur < 0.5) ? 4 : dur;
}

// Duration of the main content (sum of scene timings, audio track, narration, or explainer target)
function getNLEContentDuration() {
  let sceneDur = 0;
  if (state.scenes.length > 0 && state.scenes[0].start !== null) {
    sceneDur = state.scenes.reduce((sum, s) => {
      return sum + Math.max(0.5, timeToSeconds(s.end || '00:10') - timeToSeconds(s.start || '00:00'));
    }, 0);
  }

  // Explainer mode: total duration is driven by scene timings or target explainer duration or narration audio duration
  if (state.mode === 'explainer') {
    if (sceneDur > 0) return sceneDur;
    if (state.narrationAudio && state.narrationAudio.duration > 0) return state.narrationAudio.duration;
    if (state.explainer && state.explainer.durationSeconds > 0) return state.explainer.durationSeconds;
    if (state.audio && state.audio.duration > 0) return state.audio.duration;
    return 60;
  }

  // Music / Sync mode: take the maximum of scene duration or audio duration
  if (sceneDur > 0) {
    return state.audio && state.audio.duration > 0
      ? Math.max(state.audio.duration, sceneDur)
      : sceneDur;
  }
  if (state.audio && state.audio.duration > 0) return state.audio.duration;
  if (state.narrationAudio && state.narrationAudio.duration > 0) return state.narrationAudio.duration;
  return state.explainer ? state.explainer.durationSeconds : 60;
}

// Absolute timeline segments [start, end) for every scene (after the intro card)
function getSceneTimelineSegments() {
  const intro = getNLEIntroDuration();
  let offset = intro;
  return state.scenes.map((scene, index) => {
    const dur = scene.start && scene.end
      ? Math.max(0.5, timeToSeconds(scene.end) - timeToSeconds(scene.start))
      : 10;
    const seg = { scene, index, start: offset, end: offset + dur };
    offset += dur;
    return seg;
  });
}

/* ---------------- Timeline clip drag-resize ---------------- */

// Seconds → "MM:SS.S" (accepted back by timeToSeconds, which parses float seconds)
function formatMMSS(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${String(m).padStart(2, '0')}:${s.padStart(4, '0')}`;
}

// Floating timecode tooltip shown while dragging
let dragTipEl = null;
function showDragTip(x, y, text) {
  if (!dragTipEl) {
    dragTipEl = document.createElement('div');
    dragTipEl.className = 'drag-time-tip';
    document.body.appendChild(dragTipEl);
  }
  dragTipEl.style.left = `${x + 14}px`;
  dragTipEl.style.top = `${y - 30}px`;
  dragTipEl.innerText = text;
  dragTipEl.style.display = 'block';
}
function hideDragTip() { if (dragTipEl) dragTipEl.style.display = 'none'; }

// Make a timeline block resizable (edge handles) and/or movable (drag the body).
// spec: { ppx, edges: {left?, right?, move?}, live(mode, deltaSec), label(), commit(mode) }
// live() previews the box geometry during the drag; commit() writes state on release.
function attachClipDrag(el, spec) {
  const wire = (handleEl, mode) => {
    handleEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX;
      let moved = false;
      const onMove = (ev) => {
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        if (!moved) return;
        spec.live(mode, (ev.clientX - x0) / spec.ppx);
        showDragTip(ev.clientX, ev.clientY, spec.label());
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        hideDragTip();
        if (moved) {
          // Swallow the click that follows a real drag so it doesn't seek
          el.addEventListener('click', ce => ce.stopPropagation(), { capture: true, once: true });
          spec.commit(mode);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  };

  if (spec.edges.left) {
    const h = document.createElement('div');
    h.className = 'clip-handle handle-left';
    el.appendChild(h);
    wire(h, 'left');
  }
  if (spec.edges.right) {
    const h = document.createElement('div');
    h.className = 'clip-handle handle-right';
    el.appendChild(h);
    wire(h, 'right');
  }
  if (spec.edges.move) {
    el.classList.add('clip-movable');
    wire(el, 'move');
  }
}

// Render Multitrack NLE Timeline
function renderNLETimeline() {
  if (!contentTitleCards || !contentLyrics || !contentScenes) return;

  const introDuration = getNLEIntroDuration();
  const outroDuration = getNLEOutroDuration();
  const audioDuration = getNLEContentDuration();

  nleState.totalDuration = introDuration + audioDuration + outroDuration;
  nleTotalTime.innerText = formatTimecode(nleState.totalDuration);

  const pixelsPerSecond = 10 * nleState.zoom;
  const trackWidth = Math.max(800, nleState.totalDuration * pixelsPerSecond);

  [contentTitleCards, contentLyrics, contentScenes, contentAudio].forEach(el => {
    if (el) el.style.width = `${trackWidth}px`;
  });

  // Track 1: Title Cards
  contentTitleCards.innerHTML = '';
  if (introDuration > 0) {
    const introBlock = document.createElement('div');
    introBlock.className = 'timeline-block block-title-card';
    introBlock.style.left = '0px';
    introBlock.style.width = `${introDuration * pixelsPerSecond}px`;
    introBlock.innerText = `Intro: ${nleIntroTitle ? nleIntroTitle.value : 'Title'}`;
    contentTitleCards.appendChild(introBlock);
  }
  if (outroDuration > 0) {
    const outroBlock = document.createElement('div');
    outroBlock.className = 'timeline-block block-title-card';
    outroBlock.style.left = `${(introDuration + audioDuration) * pixelsPerSecond}px`;
    outroBlock.style.width = `${outroDuration * pixelsPerSecond}px`;
    outroBlock.innerText = `Outro CTA`;
    contentTitleCards.appendChild(outroBlock);
  }

  // Track 2: Lyrics Blocks (karaoke sing-along track)
  contentLyrics.innerHTML = '';
  const lyricsList = getLyricsBlocks();
  lyricsList.forEach((l, i) => {
    const lBlock = document.createElement('div');
    lBlock.className = 'timeline-block block-lyric';
    lBlock.style.left = `${(introDuration + l.startTime) * pixelsPerSecond}px`;
    lBlock.style.width = `${l.duration * pixelsPerSecond}px`;
    lBlock.dataset.start = introDuration + l.startTime;
    lBlock.dataset.end = introDuration + l.startTime + l.duration;
    lBlock.innerText = `${l.text}`;
    lBlock.addEventListener('click', (e) => {
      e.stopPropagation();
      seekNLE(introDuration + l.startTime);
    });

    // Drag to retime: edges resize, body moves (explainer timing is scene-bound)
    if (state.mode !== 'explainer') {
      let pending = null;
      attachClipDrag(lBlock, {
        ppx: pixelsPerSecond,
        edges: { left: true, right: true, move: true },
        live: (mode, d) => {
          const s0 = +l.startTime, dur0 = +l.duration;
          let ns = s0, nd = dur0;
          if (mode === 'left') {
            ns = Math.max(0, Math.min(s0 + d, s0 + dur0 - 0.3));
            nd = s0 + dur0 - ns;
          } else if (mode === 'right') {
            nd = Math.max(0.3, dur0 + d);
          } else {
            ns = Math.max(0, s0 + d);
          }
          lBlock.style.left = `${(introDuration + ns) * pixelsPerSecond}px`;
          lBlock.style.width = `${nd * pixelsPerSecond}px`;
          pending = { ns, nd };
        },
        label: () => pending ? `${pending.ns.toFixed(1)}s → ${(pending.ns + pending.nd).toFixed(1)}s` : '',
        commit: () => {
          const lines = ensureTimedLyricsEditable();
          if (!lines || !lines[i] || !pending) { renderNLETimeline(); return; }
          lines[i].startTime = Math.round(pending.ns * 10) / 10;
          lines[i].duration = Math.round(pending.nd * 10) / 10;
          renderSubtitleEditor();
          renderNLETimeline();
          updateNLEState(nleState.currentTime);
        }
      });
    }
    contentLyrics.appendChild(lBlock);
  });

  // Track 3: Scenes Blocks
  contentScenes.innerHTML = '';
  getSceneTimelineSegments().forEach(({ scene, index, start, end }) => {
    const sBlock = document.createElement('div');
    sBlock.className = `timeline-block block-scene ${scene.generatedUrl ? 'has-video' : 'is-empty'}`;
    sBlock.style.left = `${start * pixelsPerSecond}px`;
    sBlock.style.width = `${(end - start) * pixelsPerSecond}px`;
    sBlock.dataset.start = start;
    sBlock.dataset.end = end;
    sBlock.innerText = `S${index + 1} · ${scene.prompt || 'Prompt'}`;

    // Click a scene block to seek the synced preview to its start
    sBlock.addEventListener('click', (e) => {
      e.stopPropagation();
      seekNLE(start);
    });

    // Drag the right edge to retime the scene; later scenes ripple to stay contiguous
    if (scene.start && scene.end) {
      const dur0 = end - start;
      let pendingDur = null;
      attachClipDrag(sBlock, {
        ppx: pixelsPerSecond,
        edges: { right: true },
        live: (mode, d) => {
          pendingDur = Math.max(1, dur0 + d);
          sBlock.style.width = `${pendingDur * pixelsPerSecond}px`;
        },
        label: () => `S${index + 1}: ${(pendingDur || dur0).toFixed(1)}s`,
        commit: () => {
          if (pendingDur === null) { renderNLETimeline(); return; }
          const nd = Math.round(pendingDur * 10) / 10;
          const delta = nd - dur0;
          scene.end = formatMMSS(timeToSeconds(scene.start) + nd);
          // Ripple: shift every later scene's song window by the same amount
          for (let j = index + 1; j < state.scenes.length; j++) {
            const sc = state.scenes[j];
            if (sc.start) sc.start = formatMMSS(timeToSeconds(sc.start) + delta);
            if (sc.end) sc.end = formatMMSS(timeToSeconds(sc.end) + delta);
          }
          renderStoryboard();
          renderNLETimeline();
          updateNLEState(nleState.currentTime);
        }
      });
    }

    contentScenes.appendChild(sBlock);
  });

  // Track 4: Audio Waveform
  renderAudioWaveformCanvas(trackWidth, introDuration * pixelsPerSecond, audioDuration * pixelsPerSecond);

  updateNLEState(nleState.currentTime);
  scheduleProjectSave(); // timeline re-renders follow every project mutation
}

// Draw Audio Waveform onto Waveform Canvas (real decoded peaks when available)
function renderAudioWaveformCanvas(width, audioOffsetPx = 0, audioWidthPx = null) {
  if (!waveformCanvas) return;
  waveformCanvas.width = width;
  waveformCanvas.height = 55;
  if (audioWidthPx === null) audioWidthPx = width;

  const ctx = waveformCanvas.getContext('2d');
  ctx.clearRect(0, 0, width, 55);

  // Draw background grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 55);
    ctx.stroke();
  }

  if (!state.audio) return; // no audio track loaded — leave the lane empty

  ctx.fillStyle = '#06b6d4';

  if (nleState.waveformPeaks) {
    // Real waveform: map decoded peaks onto the audio segment of the timeline
    const peaks = nleState.waveformPeaks;
    const barWidth = 2;
    const numBars = Math.floor(audioWidthPx / 3);
    for (let i = 0; i < numBars; i++) {
      const peak = peaks[Math.floor((i / numBars) * peaks.length)] || 0;
      const spikeHeight = Math.max(2, peak * 50);
      const x = audioOffsetPx + i * 3;
      const y = (55 - spikeHeight) / 2;
      ctx.fillRect(x, y, barWidth, spikeHeight);
    }
  } else {
    // Placeholder spikes while the real waveform decodes
    ctx.globalAlpha = 0.35;
    const numSpikes = Math.floor(audioWidthPx / 3);
    for (let i = 0; i < numSpikes; i++) {
      const spikeHeight = Math.random() * 40 + 5;
      ctx.fillRect(audioOffsetPx + i * 3, (55 - spikeHeight) / 2, 2, spikeHeight);
    }
    ctx.globalAlpha = 1;
  }
}

// Decode uploaded audio into amplitude peaks for the waveform lane
async function loadWaveformPeaks(filename) {
  try {
    const resp = await fetch(`/outputs/${filename}`);
    const arrayBuf = await resp.arrayBuffer();
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await actx.decodeAudioData(arrayBuf);
    const channel = audioBuf.getChannelData(0);

    const numPeaks = 2000;
    const blockSize = Math.max(1, Math.floor(channel.length / numPeaks));
    const peaks = new Array(numPeaks);
    for (let i = 0; i < numPeaks; i++) {
      let max = 0;
      const start = i * blockSize;
      for (let j = 0; j < blockSize; j += 32) {
        const v = Math.abs(channel[start + j] || 0);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }

    nleState.waveformPeaks = peaks;
    actx.close();
    renderNLETimeline();
  } catch (err) {
    console.warn("Waveform decoding failed, keeping placeholder:", err);
  }
}

// Update Live Subtitle Overlay & Playhead
function updateNLEState(timeSec) {
  nleState.currentTime = timeSec;
  nleCurrentTime.innerText = formatTimecode(timeSec);

  // Position Playhead
  const pixelsPerSecond = 10 * nleState.zoom;
  const leftPos = 120 + timeSec * pixelsPerSecond;
  if (timelinePlayhead) {
    timelinePlayhead.style.left = `${leftPos}px`;
  }

  // Auto-scroll the viewport to keep the playhead visible while playing
  if (nleState.isPlaying && timelineViewport) {
    const viewLeft = timelineViewport.scrollLeft;
    const viewWidth = timelineViewport.clientWidth;
    if (leftPos > viewLeft + viewWidth - 80 || leftPos < viewLeft + 120) {
      timelineViewport.scrollLeft = Math.max(0, leftPos - viewWidth / 2);
    }
  }

  // Keep audio + scene video locked to the master clock
  syncAudioToTimeline(false);
  syncSceneVideoToTimeline();
  updateTitleCardOverlay(timeSec);

  // Highlight the active blocks on every track
  document.querySelectorAll('.timeline-block[data-start]').forEach(block => {
    const s = parseFloat(block.dataset.start);
    const e = parseFloat(block.dataset.end);
    block.classList.toggle('active', timeSec >= s && timeSec < e);
  });

  // Render Karaoke Subtitle Overlay
  const introDuration = getNLEIntroDuration();
  const audioTime = timeSec - introDuration;
  const lyricsList = getLyricsBlocks();

  const currentLyric = lyricsList.find(l => audioTime >= l.startTime && audioTime < (l.startTime + l.duration));

  const pos = nleSubPosition ? nleSubPosition.value : 'none';

  if (pos !== 'none' && currentLyric && nleSubtitleOverlay) {
    const fontSize = nleSubFontSize ? nleSubFontSize.value : '32';
    const color = nleSubTextColor ? nleSubTextColor.value : '#ffffff';
    const stroke = nleSubStrokeColor ? nleSubStrokeColor.value : '#000000';
    const hasBg = nleSubBgBox ? nleSubBgBox.checked : true;

    let posStyle = 'bottom: 8%; top: auto;';
    if (pos === 'top') posStyle = 'top: 8%; bottom: auto;';
    if (pos === 'center') posStyle = 'top: 45%; bottom: auto;';

    const bgStyle = hasBg ? 'background: rgba(0, 0, 0, 0.65);' : 'background: transparent;';

    // Karaoke sing-along: fill the line with highlight color as it progresses
    const progress = Math.min(1, Math.max(0, (audioTime - currentLyric.startTime) / currentLyric.duration));
    const pct = (progress * 100).toFixed(1);

    maybeSpeakPreviewLine(currentLyric);

    nleSubtitleOverlay.style = posStyle;
    nleSubtitleOverlay.innerHTML = `
      <span class="nle-subtitle-text" style="${bgStyle}">
        <span class="karaoke-text" style="
          font-size: ${fontSize}px;
          background: linear-gradient(90deg, #fde047 ${pct}%, ${color} ${pct}%);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          text-shadow: none;
          filter: drop-shadow(1px 1px 0 ${stroke}) drop-shadow(-1px -1px 0 ${stroke});
        ">${currentLyric.text}</span>
      </span>
    `;
  } else if (nleSubtitleOverlay) {
    nleSubtitleOverlay.innerHTML = '';
  }
}

// Show intro/outro title card overlays during their timeline windows
// Build the preview HTML for one card, honoring its style options
function cardOverlayHtml(which, titleText, subText, subColorCss) {
  const src = getCardImageSrc(which);
  const storedImage = state.cardImages[which];
  const bakedText = !!(storedImage && typeof storedImage === 'object' && storedImage.bakedText);
  if (bakedText) {
    titleText = '';
    subText = '';
  }
  const mode = getInputValue(which === 'intro' ? 'introImageMode' : 'outroImageMode') || 'background';
  const kb = !!getInputValue(which === 'intro' ? 'introKenBurns' : 'outroKenBurns');
  const subscribe = !!getInputValue(which === 'intro' ? 'introSubscribe' : 'outroSubscribe');
  const pill = subscribe ? '<div class="subscribe-pill">▶ SUBSCRIBE</div>' : '';

  if (src && mode === 'background') {
    return {
      bgMode: true,
      html: `
        <div class="card-bg ${kb ? 'kenburns' : ''}" style="background-image:url('${src}')"></div>
        <div class="card-scrim"></div>
        <div class="card-lower">
          <div class="nle-card-title">${titleText}</div>
          <div class="nle-card-subtitle" style="color: ${subColorCss};">${subText}</div>
          ${pill}
        </div>`
    };
  }
  const img = src ? `<img class="nle-card-image" src="${src}" alt="">` : '';
  return {
    bgMode: false,
    html: `
      ${img}
      <div class="nle-card-title">${titleText}</div>
      <div class="nle-card-subtitle" style="color: ${subColorCss};">${subText}</div>
      ${pill}`
  };
}

function updateTitleCardOverlay(timeSec) {
  if (!nleCardOverlay) return;

  const intro = getNLEIntroDuration();
  const outro = getNLEOutroDuration();
  const outroStart = nleState.totalDuration - outro;

  let card = null;
  if (intro > 0 && timeSec < intro) {
    card = cardOverlayHtml('intro',
      nleIntroTitle ? nleIntroTitle.value : '',
      nleIntroSubtitle ? nleIntroSubtitle.value : '', '#a78bfa');
  } else if (outro > 0 && timeSec >= outroStart) {
    card = cardOverlayHtml('outro',
      nleOutroTitle ? nleOutroTitle.value : '',
      nleOutroCTA ? nleOutroCTA.value : '', '#38bdf8');
  }

  if (card) {
    nleCardOverlay.style.display = 'flex';
    nleCardOverlay.classList.toggle('bg-mode', card.bgMode);
    nleCardOverlay.innerHTML = card.html;
  } else {
    nleCardOverlay.style.display = 'none';
  }
}

// Keep one media element in lockstep with a content-relative time position
function syncMediaElement(el, trackDuration, contentT, forceSeek) {
  if (!el || !trackDuration || !el.src) return;

  if (contentT >= 0 && contentT < trackDuration) {
    if (forceSeek || Math.abs(el.currentTime - contentT) > 0.3) {
      el.currentTime = Math.max(0, contentT);
    }
    if (nleState.isPlaying && el.paused) {
      el.play().catch(() => {});
    } else if (!nleState.isPlaying && !el.paused) {
      el.pause();
    }
  } else if (!el.paused) {
    el.pause();
  }
}

// Keep music + TTS voiceover tracks locked to the master clock
function syncAudioToTimeline(forceSeek) {
  const contentT = nleState.currentTime - getNLEIntroDuration();
  syncMediaElement(nleAudioElement, state.audio ? state.audio.duration : 0, contentT, forceSeek);
  syncMediaElement(nleNarrationElement, state.narrationAudio ? state.narrationAudio.duration : 0, contentT, forceSeek);
}

// Switch and align the preview video to whichever scene the playhead is inside
function syncSceneVideoToTimeline() {
  if (!nlePreviewVideo) return;

  const t = nleState.currentTime;
  const active = getSceneTimelineSegments().find(seg =>
    t >= seg.start && t < seg.end && seg.scene.generatedUrl
  );

  if (!active) {
    if (!nlePreviewVideo.paused) nlePreviewVideo.pause();
    return;
  }

  const src = active.scene.generatedUrl;
  if (nlePreviewVideo.getAttribute('data-scene-src') !== src) {
    nlePreviewVideo.setAttribute('data-scene-src', src);
    nlePreviewVideo.src = src;
    nlePreviewVideo.muted = true; // soundtrack comes from the audio track
    nlePreviewVideo.loop = true;
  }

  // Align clip position within the scene (looping if the clip is shorter than the slot)
  const local = t - active.start;
  if (nlePreviewVideo.duration && isFinite(nlePreviewVideo.duration)) {
    const target = local % nlePreviewVideo.duration;
    if (Math.abs(nlePreviewVideo.currentTime - target) > 0.4) {
      nlePreviewVideo.currentTime = target;
    }
  }

  if (nleState.isPlaying && nlePreviewVideo.paused) {
    nlePreviewVideo.play().catch(() => {});
  } else if (!nleState.isPlaying && !nlePreviewVideo.paused) {
    nlePreviewVideo.pause();
  }
}

// Master clock playback loop
function nleRafLoop() {
  if (!nleState.isPlaying) return;

  const t = (performance.now() - nleState.playStartWall) / 1000;
  if (t >= nleState.totalDuration) {
    updateNLEState(nleState.totalDuration);
    pauseNLEPlayback();
    return;
  }

  updateNLEState(t);
  nleState.rafId = requestAnimationFrame(nleRafLoop);
}

function startNLEPlayback() {
  stopAuditions(); // avoid double audio with an inline audition player
  stopScenePreview(); // and with a per-scene song segment preview
  // Restart from the top if playback already finished
  if (nleState.currentTime >= nleState.totalDuration - 0.05) {
    nleState.currentTime = 0;
  }
  nleState.isPlaying = true;
  if (btnNLEPlayPause) btnNLEPlayPause.innerText = '⏸';
  nleState.playStartWall = performance.now() - nleState.currentTime * 1000;
  syncAudioToTimeline(true);
  nleState.rafId = requestAnimationFrame(nleRafLoop);
}

function pauseNLEPlayback() {
  nleState.isPlaying = false;
  if (btnNLEPlayPause) btnNLEPlayPause.innerText = '▶';
  if (nleAudioElement) nleAudioElement.pause();
  if (nleNarrationElement) nleNarrationElement.pause();
  if (nlePreviewVideo) nlePreviewVideo.pause();
  if (nleState.rafId) cancelAnimationFrame(nleState.rafId);
  nleState.rafId = null;
  cancelPreviewSpeech();
}

// Seek the whole synced preview (playhead, audio, video, karaoke) to a time
function seekNLE(timeSec) {
  const t = Math.max(0, Math.min(timeSec, nleState.totalDuration));
  nleState.currentTime = t;
  nleState.playStartWall = performance.now() - t * 1000;
  cancelPreviewSpeech();
  syncAudioToTimeline(true);
  updateNLEState(t);
}

// Browser speechSynthesis preview (quick check before generating the real TTS track)
let lastSpokenLineText = null;

function cancelPreviewSpeech() {
  lastSpokenLineText = null;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function maybeSpeakPreviewLine(lyric) {
  if (!nleState.isPlaying) return;
  if (!nleSpeakPreview || !nleSpeakPreview.checked) return;
  if (state.narrationAudio) return; // real voiceover track plays instead
  if (!window.speechSynthesis) return;
  if (lastSpokenLineText === lyric.text) return;

  lastSpokenLineText = lyric.text;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(lyric.text);
  window.speechSynthesis.speak(utterance);
}

// Transport Controls Play/Pause
if (btnNLEPlayPause) {
  btnNLEPlayPause.addEventListener('click', () => {
    if (nleState.isPlaying) {
      pauseNLEPlayback();
    } else {
      startNLEPlayback();
    }
  });
}

// Scrubber Click on Timeline Viewport
if (timelineViewport) {
  timelineViewport.addEventListener('click', (e) => {
    const rect = timelineViewport.getBoundingClientRect();
    const clickX = e.clientX - rect.left - 120 + timelineViewport.scrollLeft;
    if (clickX < 0) return;

    const pixelsPerSecond = 10 * nleState.zoom;
    const targetSec = clickX / pixelsPerSecond;
    if (targetSec <= nleState.totalDuration) {
      seekNLE(targetSec);
    }
  });
}

// Update the voiceover tab status line
function updateVoiceoverStatus() {
  if (!voiceoverStatus) return;
  if (state.narrationAudio) {
    const engineLabels = {
      'gemini-3.1': 'Gemini 3.1 Flash Audio',
      'gemini-2.5': 'Gemini 2.5 TTS',
      'say': 'local voice'
    };
    const engineLabel = engineLabels[state.narrationAudio.engine] || 'Gemini TTS';
    voiceoverStatus.innerText = `✅ Voiceover ready (${state.narrationAudio.duration.toFixed(1)}s, ${engineLabel}). It plays in the preview and will be mixed into the final render.`;
    voiceoverStatus.style.color = 'var(--color-success)';
  } else {
    voiceoverStatus.innerText = 'No voiceover yet. Generate a script first, then create the voiceover.';
    voiceoverStatus.style.color = 'var(--color-text-muted)';
  }
  if (nleNarrationElement && !state.narrationAudio) {
    nleNarrationElement.pause();
    nleNarrationElement.removeAttribute('src');
  }
  scheduleProjectSave();
}

// Generate the AI TTS voiceover track from the narration/lyrics lines
async function generateVoiceover() {
  const lines = getLyricsBlocks().map(l => ({ text: l.text, startTime: l.startTime }));
  if (lines.length === 0) {
    showToast("No narration or lyrics found. Generate a video plan or add lyrics first.", "warning");
    return;
  }

  const btn = document.getElementById('btnGenerateVoiceover');
  btn.disabled = true;
  btn.innerText = "Synthesizing Voiceover...";
  if (voiceoverStatus) {
    voiceoverStatus.innerText = `Synthesizing ${lines.length} narration lines...`;
    voiceoverStatus.style.color = 'var(--color-text-muted)';
  }

  try {
    const res = await fetch('/api/generate-narration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lines: lines,
        voice: nleVoiceSelect ? nleVoiceSelect.value : 'Kore'
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to generate voiceover");
    }

    const data = await res.json();
    state.narrationAudio = { filename: data.filename, duration: data.duration, engine: data.engine };
    if (nleNarrationElement) nleNarrationElement.src = `/outputs/${data.filename}`;
    updateVoiceoverStatus();
    showToast("AI voiceover generated! Press play to hear it in sync.", "success");
  } catch (error) {
    console.error(error);
    updateVoiceoverStatus();
    showToast(`Voiceover generation failed: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerText = "Generate AI Voiceover Track";
  }
}

// Pause any inline audition players (used before regenerating or playing the timeline)
function stopAuditions() {
  ['songAuditionPlayer', 'musicAuditionPlayer'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.paused) el.pause();
  });
  if (typeof subEditAudio !== 'undefined' && subEditAudio && !subEditAudio.paused) subEditAudio.pause();
}

// Show a generated track in an inline audition player for quality review
function showAudition(boxId, playerId, filename) {
  const box = document.getElementById(boxId);
  const player = document.getElementById(playerId);
  if (player) {
    player.src = `/outputs/${filename}`;
    player.load();
  }
  if (boxId === 'songAuditionBox') {
    const dlBtn = document.getElementById('btnDownloadAuditionSong');
    if (dlBtn) {
      dlBtn.href = `/outputs/${filename}`;
      dlBtn.download = filename;
    }
  }
  if (box) box.style.display = 'flex';
}

// Generate a full song (with vocals) from a prompt, then auto-transcribe timed lyrics
async function generateSong() {
  const songPromptInput = document.getElementById('songPromptInput');
  const songStatus = document.getElementById('songStatus');
  const btn = document.getElementById('btnGenerateSong');
  const promptText = songPromptInput.value.trim();

  if (!promptText) {
    showToast("Describe the song you want first.", "warning");
    return;
  }

  btn.disabled = true;
  btn.innerText = "Composing Song...";
  songStatus.innerText = `Lyria is composing your song with vocals — length set by the model... (this can take a minute)`;
  songStatus.style.color = 'var(--color-text-muted)';

  try {
    const res = await fetch('/api/generate-song', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to generate song");
    }

    const data = await res.json();

    // The generated song becomes the project's audio track
    state.audio = { filename: data.filename, duration: Math.round(data.duration * 10) / 10 };
    audioFilenameText.innerText = "AI Song (Lyria 3)";
    audioDurationText.innerText = `Duration: ${state.audio.duration}s`;
    audioPreviewContainer.style.display = 'flex';

    const dlMain = document.getElementById('btnDownloadAudio');
    if (dlMain) {
      dlMain.href = `/outputs/${data.filename}`;
      dlMain.download = data.filename;
    }

    if (nleAudioElement) nleAudioElement.src = `/outputs/${data.filename}`;
    nleState.waveformPeaks = null;
    loadWaveformPeaks(data.filename);

    // Let the user audition the song right here before continuing
    showAudition('songAuditionBox', 'songAuditionPlayer', data.filename);

    // Transcribe the sung lyrics with real line timestamps for karaoke sync + SRT
    btn.innerText = "Transcribing Lyrics...";
    songStatus.innerText = "Song ready. Transcribing lyrics with line timestamps...";

    await transcribeSongLyrics(data.filename);

    renderNLETimeline();
    songStatus.innerText = `✅ Song ready (${state.audio.duration}s) with ${state.timedLyrics.length} time-synced lyric lines. Export them as .srt from the Studio.`;
    songStatus.style.color = 'var(--color-success)';
    showToast("Lyria song and time-synced lyrics ready! Now generate the scene script.", "success");
  } catch (error) {
    console.error(error);
    songStatus.innerText = `${error.message}`;
    songStatus.style.color = 'var(--color-warning)';
    showToast(`Song generation problem: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerText = "Generate Song & Lyrics";
  }
}

// Transcribe timed lyrics for an audio file (retries once — the request can be slow)
async function transcribeSongLyrics(filename) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const txRes = await fetch('/api/transcribe-lyrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioFilename: filename })
      });

      if (!txRes.ok) {
        const err = await txRes.json();
        throw new Error(err.error || `Transcription failed (status ${txRes.status})`);
      }

      const txData = await txRes.json();
      state.timedLyrics = (txData.lines || []).map(l => ({
        text: l.text,
        startTime: Math.max(0, parseFloat(l.startSec) || 0),
        duration: Math.max(0.5, (parseFloat(l.endSec) || 0) - (parseFloat(l.startSec) || 0))
      }));
      lyricsInput.value = state.timedLyrics.map(l => l.text).join('\n');
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Lyric transcription attempt ${attempt} failed:`, err);
    }
  }
  throw new Error(`Song created, but lyric transcription failed: ${lastError.message}`);
}

// Build SRT captions text from the current lyric/narration timeline ('' if none)
// Build SRT text from timed blocks [{text, startTime, duration}] with an offset
function linesToSRT(blocks, offset = 0) {
  if (!blocks || blocks.length === 0) return '';
  const fmtSRT = (secs) => {
    secs = Math.max(0, secs);
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(secs % 60)).padStart(2, '0');
    const ms = String(Math.round((secs % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
  };
  return blocks.map((b, i) =>
    `${i + 1}\n${fmtSRT(offset + b.startTime)} --> ${fmtSRT(offset + b.startTime + b.duration)}\n${b.text}\n`
  ).join('\n');
}

function buildSRTContent() {
  return linesToSRT(getLyricsBlocks(), getNLEIntroDuration());
}

/* ==========================================================================
   Subtitle Editor — manually correct text and timings of subtitle lines
   ========================================================================== */

// Make the current lyric blocks explicitly editable: materialize them into
// state.timedLyrics (music mode) so per-line timing edits stick.
function ensureTimedLyricsEditable() {
  if (state.mode === 'explainer') return null; // explainer timing follows scenes
  if (!state.timedLyrics || state.timedLyrics.length === 0) {
    const blocks = getLyricsBlocks();
    if (blocks.length === 0) return null;
    state.timedLyrics = blocks.map(b => ({
      text: b.text,
      startTime: +b.startTime,
      duration: +b.duration
    }));
  }
  return state.timedLyrics;
}

function renderSubtitleEditor() {
  const holder = document.getElementById('subtitleEditor');
  if (!holder) return;
  const explainer = state.mode === 'explainer';
  const lines = explainer ? getLyricsBlocks() : (ensureTimedLyricsEditable() || []);

  if (lines.length === 0) {
    holder.innerHTML = '<p class="inspector-hint">No subtitle lines yet — transcribe lyrics or generate a plan first.</p>';
    return;
  }

  holder.innerHTML = lines.map((l, i) => `
    <div class="sub-row" data-i="${i}">
      <div class="sub-times">
        <button type="button" class="sub-play" data-play="${i}" title="Play this line">▶</button>
        <input type="number" class="sub-start number-input" data-i="${i}" step="0.1" min="0" value="${(+l.startTime).toFixed(1)}" ${explainer ? 'disabled' : ''} title="Start (s)">
        <span class="sub-arrow">→</span>
        <input type="number" class="sub-end number-input" data-i="${i}" step="0.1" min="0" value="${(+l.startTime + +l.duration).toFixed(1)}" ${explainer ? 'disabled' : ''} title="End (s)">
      </div>
      <input type="text" class="sub-text text-input" data-i="${i}" value="${escapeHtml(l.text)}">
    </div>`).join('');

  holder.querySelectorAll('.sub-text, .sub-start, .sub-end').forEach(inp => {
    inp.addEventListener('change', () => applySubtitleEdit(parseInt(inp.dataset.i, 10)));
  });
  holder.querySelectorAll('.sub-play').forEach(b => {
    b.addEventListener('click', () => playLyricLine(parseInt(b.dataset.play, 10)));
  });
}

function applySubtitleEdit(i) {
  const holder = document.getElementById('subtitleEditor');
  const row = holder && holder.querySelector(`.sub-row[data-i="${i}"]`);
  if (!row) return;
  const text = row.querySelector('.sub-text').value.trim();

  if (state.mode === 'explainer') {
    // Text maps onto the scenes' narration lines (timing is scene-bound)
    const narrated = state.scenes.filter(s => s.narration);
    if (narrated[i] && text) {
      narrated[i].narration = text;
      renderStoryboard();
    }
  } else {
    const lines = ensureTimedLyricsEditable();
    if (!lines || !lines[i]) return;
    const start = Math.max(0, parseFloat(row.querySelector('.sub-start').value) || 0);
    const end = Math.max(start + 0.2, parseFloat(row.querySelector('.sub-end').value) || (start + 0.2));
    if (text) lines[i].text = text;
    lines[i].startTime = start;
    lines[i].duration = end - start;
    // Mirror the corrected text into the setup textarea (programmatic set:
    // does not fire its input listener, so timings are preserved)
    if (lyricsInput) lyricsInput.value = lines.map(l => l.text).join('\n');
  }

  renderNLETimeline();
  updateNLEState(nleState.currentTime);
  scheduleProjectSave();
}

function shiftAllSubtitles(delta) {
  if (state.mode === 'explainer') {
    showToast("Explainer subtitle timing follows the scenes — edit scene timings instead.", "info");
    return;
  }
  const lines = ensureTimedLyricsEditable();
  if (!lines || lines.length === 0) return;
  lines.forEach(l => { l.startTime = Math.max(0, l.startTime + delta); });
  renderSubtitleEditor();
  renderNLETimeline();
  updateNLEState(nleState.currentTime);
  scheduleProjectSave();
  showToast(`All subtitles shifted ${delta > 0 ? '+' : ''}${delta.toFixed(1)}s.`, "success");
}

// Small dedicated player: audition one line against the project's audio track
let subEditAudio = null;
let subEditStopAt = 0;

function playLyricLine(i) {
  const line = getLyricsBlocks()[i];
  if (!line) return;

  if (!state.audio) {
    // No track — play the studio preview over that window instead
    seekNLE(getNLEIntroDuration() + line.startTime);
    startNLEPlayback();
    return;
  }

  pauseNLEPlayback();
  stopScenePreview();
  stopAuditions();

  if (!subEditAudio) {
    subEditAudio = new Audio();
    subEditAudio.addEventListener('timeupdate', () => {
      if (subEditStopAt && subEditAudio.currentTime >= subEditStopAt) subEditAudio.pause();
    });
  }
  const src = `/outputs/${state.audio.filename}`;
  subEditStopAt = line.startTime + line.duration + 0.15;
  const go = () => {
    subEditAudio.currentTime = Math.max(0, line.startTime - 0.15);
    subEditAudio.play().catch(() => {});
  };
  if (subEditAudio.src.endsWith(encodeURI(src)) && subEditAudio.readyState >= 1) go();
  else {
    subEditAudio.src = src;
    subEditAudio.addEventListener('loadedmetadata', go, { once: true });
  }
}

// Download the SRT captions file
function downloadSRT() {
  const srt = buildSRTContent();
  if (!srt) {
    showToast("No lyrics or narration to export yet.", "warning");
    return;
  }
  const blob = new Blob([srt], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'subtitles.srt';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Subtitles exported. Upload them as closed captions on YouTube.", "success");
}

/* ==========================================================================
   Global Reach — multi-language localization (voiceover + captions + metadata)
   ========================================================================== */

const LOCALE_LANGUAGES = [
  { code: 'es', name: 'Spanish' }, { code: 'pt', name: 'Portuguese (BR)' },
  { code: 'hi', name: 'Hindi' }, { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' }, { code: 'ja', name: 'Japanese' },
  { code: 'it', name: 'Italian' }, { code: 'id', name: 'Indonesian' },
  { code: 'ar', name: 'Arabic' }, { code: 'ko', name: 'Korean' }
];

function renderLangPicker() {
  const el = document.getElementById('langPicker');
  if (!el || el.childElementCount) return;
  el.innerHTML = LOCALE_LANGUAGES.map(l =>
    `<label class="lang-chip"><input type="checkbox" value="${l.code}"> ${l.name}</label>`
  ).join('');
}

async function generateLocalizations() {
  const blocks = getLyricsBlocks();
  if (blocks.length === 0) {
    showToast("No narration/lyrics with timings yet — generate a plan or add a timed song first.", "warning");
    return;
  }
  const picked = [...document.querySelectorAll('#langPicker input:checked')].map(c => c.value);
  if (picked.length === 0) {
    showToast("Pick at least one language.", "warning");
    return;
  }

  const btn = document.getElementById('btnLocalize');
  const status = document.getElementById('localizeStatus');
  btn.disabled = true;
  state.localizations = state.localizations || [];

  const baseLines = blocks.map(b => ({ text: b.text, startTime: b.startTime, duration: b.duration }));
  const topic = state.explainer ? state.explainer.topic : null;
  const lyricsText = topic ? null : baseLines.map(b => b.text).join('\n');

  try {
    for (let i = 0; i < picked.length; i++) {
      const code = picked[i];
      const langName = (LOCALE_LANGUAGES.find(l => l.code === code) || {}).name || code;
      btn.innerText = `Localizing ${langName} (${i + 1}/${picked.length})…`;
      if (status) { status.innerText = `${langName}: translating + synthesizing native voiceover…`; status.style.color = 'var(--color-text-muted)'; }

      try {
        // 1) translate + voiceover
        const locRes = await fetch('/api/localize', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines: baseLines, langCode: code })
        });
        if (!locRes.ok) throw new Error((await locRes.json()).error || 'localize failed');
        const loc = await locRes.json();

        // 2) localized SEO metadata (title + description), best-effort
        let meta = null;
        try {
          const seoRes = await fetch('/api/generate-seo', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              topic, lyrics: lyricsText, durationSeconds: getNLEContentDuration(),
              sceneCount: state.scenes.length || 6, language: loc.language
            })
          });
          if (seoRes.ok) meta = await seoRes.json();
        } catch { /* metadata optional */ }

        const entry = {
          langCode: code, language: loc.language, lines: loc.lines,
          voiceover: loc.voiceover, title: meta ? (meta.titles || [])[0] : '',
          description: meta ? meta.description : '', tags: meta ? meta.tags : []
        };
        state.localizations = state.localizations.filter(x => x.langCode !== code);
        state.localizations.push(entry);
        renderLocalizations();
      } catch (err) {
        console.error(`Localize ${langName} failed:`, err);
        showToast(`${langName} failed: ${err.message}`, "error");
      }
    }
    if (status) { status.innerText = `Done — ${state.localizations.length} language track(s) ready.`; status.style.color = 'var(--color-success)'; }
    scheduleProjectSave();
  } finally {
    btn.disabled = false;
    btn.innerText = 'Generate Localizations';
  }
}

function renderLocalizations() {
  const grid = document.getElementById('localizeResults');
  if (!grid) return;
  const introOffset = getNLEIntroDuration();
  grid.innerHTML = (state.localizations || []).map(loc => {
    const srt = encodeURIComponent(linesToSRT(loc.lines, introOffset));
    return `
    <div class="loc-card">
      <div class="loc-head"><strong>${escapeHtml(loc.language)}</strong>
        <span class="muted">${loc.voiceover ? loc.voiceover.duration.toFixed(0) + 's voiceover' : ''}</span></div>
      ${loc.voiceover ? `<audio controls src="/outputs/${loc.voiceover.filename}"></audio>` : ''}
      ${loc.title ? `<div class="loc-line"><span class="pd-label">Title</span>${escapeHtml(loc.title)}</div>` : ''}
      <div class="loc-actions">
        ${loc.voiceover ? `<a class="btn btn-secondary btn-sm" href="/outputs/${loc.voiceover.filename}" download="voiceover_${loc.langCode}.m4a">Voiceover</a>` : ''}
        <a class="btn btn-secondary btn-sm" href="data:text/plain;charset=utf-8,${srt}" download="captions_${loc.langCode}.srt">Captions .srt</a>
        ${loc.description ? `<button class="btn btn-secondary btn-sm" data-loc-desc="${loc.langCode}">Copy description</button>` : ''}
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-loc-desc]').forEach(b => b.addEventListener('click', () => {
    const loc = state.localizations.find(x => x.langCode === b.dataset.locDesc);
    if (loc) navigator.clipboard.writeText(loc.description).then(() => showToast("Description copied.", "success"));
  }));
}

/* ==========================================================================
   Direct YouTube upload (OAuth)
   ========================================================================== */

async function refreshYouTubeStatus() {
  const statusEl = document.getElementById('ytStatus');
  const connectBtn = document.getElementById('btnYtConnect');
  const disconnectBtn = document.getElementById('btnYtDisconnect');
  const form = document.getElementById('ytUploadForm');
  if (!statusEl) return;
  await populateYouTubeChannelSelect();
  const channelId = selectedYouTubeChannelId();
  if (!channelId) {
    statusEl.innerText = 'Add or select a YouTube channel in the Planner first.';
    statusEl.style.color = 'var(--color-text-muted)';
    connectBtn.style.display = 'none'; disconnectBtn.style.display = 'none'; form.style.display = 'none';
    return;
  }
  try {
    const channelQuery = `?channelId=${encodeURIComponent(channelId)}`;
    const res = await fetch(`/api/youtube/status${channelQuery}`);
    const s = await res.json();
    if (!s.configured) {
      statusEl.innerText = 'Not set up: add YT_CLIENT_ID / YT_CLIENT_SECRET to .env and enable the YouTube Data API (see .env.example).';
      statusEl.style.color = 'var(--color-text-muted)';
      connectBtn.style.display = 'none'; disconnectBtn.style.display = 'none'; form.style.display = 'none';
      return;
    }
    if (s.connected) {
      statusEl.innerText = `Connected as “${s.channel}”.`;
      statusEl.style.color = 'var(--color-success)';
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'inline-block';
      form.style.display = 'block';
      prefillYouTubeForm();
    } else {
      statusEl.innerText = s.error ? `Not connected (${s.error}).` : 'Not connected yet.';
      statusEl.style.color = 'var(--color-text-muted)';
      connectBtn.style.display = 'inline-block';
      disconnectBtn.style.display = 'none';
      form.style.display = 'none';
    }
  } catch (err) {
    statusEl.innerText = 'Could not check YouTube status.';
  }
}

function selectedYouTubeChannelId() {
  return state.youtubeChannelId || state.channelId || '';
}

async function populateYouTubeChannelSelect() {
  const select = document.getElementById('ytChannelSelect');
  if (!select) return;
  const channels = (await getChannelList()).filter(channel => channel.platform !== 'instagram');
  const selected = selectedYouTubeChannelId();
  if (!state.youtubeChannelId && selected) state.youtubeChannelId = selected;
  select.innerHTML = channels.length
    ? channels.map(channel => `<option value="${escapeHtml(channel.id)}" ${channel.id === selected ? 'selected' : ''}>${escapeHtml(channel.name)}</option>`).join('')
    : '<option value="">No YouTube channels configured</option>';
  select.disabled = channels.length === 0;
  if (channels.length && !channels.some(channel => channel.id === selected)) {
    state.youtubeChannelId = channels[0].id;
    select.value = state.youtubeChannelId;
  }
}

function prefillYouTubeForm() {
  const kit = state.lastSEOKit;
  const title = document.getElementById('ytTitle');
  const desc = document.getElementById('ytDescription');
  const tags = document.getElementById('ytTags');
  if (title && !title.value) title.value = (kit && kit.titles && kit.titles[0]) || (state.explainer && state.explainer.videoTitle) || (nleIntroTitle && nleIntroTitle.value) || '';
  if (desc && !desc.value) desc.value = withChapters((kit && kit.description) || '');
  if (tags && !tags.value) tags.value = (kit && kit.tags ? kit.tags.join(', ') : '');
}

async function uploadToYouTube() {
  if (!state.lastRender || !state.lastRender.filename) {
    showToast('Render the master video in the Studio first.', 'warning');
    return;
  }
  const title = document.getElementById('ytTitle').value.trim();
  if (!title) { showToast('A title is required.', 'warning'); return; }

  const privacy = getInputValue('ytPrivacy');
  if (privacy === 'public' && !confirm('Upload as PUBLIC — anyone can see it immediately. Continue?')) return;

  const btn = document.getElementById('btnYtUpload');
  const status = document.getElementById('ytUploadStatus');
  btn.disabled = true;
  btn.innerText = 'Uploading… (large files take a while)';
  status.innerText = 'Uploading video to YouTube…';
  status.style.color = 'var(--color-text-muted)';

  try {
    const includeThumb = !!getInputValue('ytIncludeThumb');
    const includeCaptions = !!getInputValue('ytIncludeCaptions');
    const res = await fetch('/api/youtube/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: selectedYouTubeChannelId(),
        videoFilename: state.lastRender.filename,
        title,
        description: withChapters(document.getElementById('ytDescription').value),
        tags: document.getElementById('ytTags').value.split(',').map(t => t.trim()).filter(Boolean),
        privacyStatus: privacy,
        thumbnailFilename: includeThumb && state.thumbnails.length ? state.thumbnails[0].filename : null,
        captionSrt: includeCaptions ? buildSRTContent() : '',
        captionLanguage: 'en'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    status.innerHTML = `Uploaded ✓ <a href="${data.url}" target="_blank" rel="noopener">${data.url}</a> (${data.privacy})`;
    status.style.color = 'var(--color-success)';
    showToast(`Uploaded to YouTube as ${data.privacy}. Review it in YouTube Studio.`, 'success');
  } catch (err) {
    console.error(err);
    status.innerText = `Upload failed: ${err.message}`;
    status.style.color = 'var(--color-warning)';
    showToast(`YouTube upload failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Upload to YouTube';
  }
}

/* ==========================================================================
   Publish: AI thumbnails + one-click upload package
   ========================================================================== */

function renderThumbGrid() {
  const grid = document.getElementById('thumbGrid');
  if (!grid) return;
  grid.innerHTML = (state.thumbnails || []).map(t => `
    <div class="thumb-item">
      <img src="${t.url}" alt="AI thumbnail">
      <a class="btn btn-secondary btn-sm" href="${t.url}" download="${t.filename}">Download</a>
    </div>
  `).join('');
}

async function generateThumbnails() {
  const btn = document.getElementById('btnGenerateThumbs');
  const status = document.getElementById('thumbStatus');

  // Concepts from the SEO kit, else fall back to the video title/topic
  let concepts = (state.lastSEOKit && state.lastSEOKit.thumbnailIdeas || []).slice(0, 2);
  const videoTitle = (state.explainer && state.explainer.videoTitle)
    || (nleIntroTitle && nleIntroTitle.value) || '';
  if (concepts.length === 0) {
    if (!videoTitle && !(state.explainer && state.explainer.topic)) {
      showToast("Generate the SEO kit (or a video plan) first so there's a concept to draw.", "warning");
      return;
    }
    concepts = [`Eye-catching hero image for a video titled "${videoTitle}" about ${state.explainer ? state.explainer.topic : videoTitle}`];
  }

  btn.disabled = true;
  let made = 0;
  const referenceImages = await collectStyleRefs(); // brand + character consistency

  try {
    for (let i = 0; i < concepts.length; i++) {
      btn.innerText = `Generating thumbnail ${i + 1}/${concepts.length}…`;
      if (status) { status.innerText = `Drawing concept ${i + 1}: ${concepts[i].slice(0, 80)}…`; status.style.color = 'var(--color-text-muted)'; }
      try {
        const res = await fetch('/api/generate-thumbnail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ concept: concepts[i], videoTitle: videoTitle, orientation: state.orientation, referenceImages })
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'generation failed');
        }
        const data = await res.json();
        state.thumbnails.push({ url: data.url, filename: data.filename });
        made++;
        renderThumbGrid();
      } catch (err) {
        console.error(`Thumbnail ${i + 1} failed:`, err);
        if (status) { status.innerText = `Thumbnail generation failed: ${err.message}`; status.style.color = 'var(--color-warning)'; }
      }
    }

    if (made > 0) {
      if (status) { status.innerText = `${made} thumbnail${made > 1 ? 's' : ''} ready — click Download or include them in the Publish Package.`; status.style.color = 'var(--color-success)'; }
      showToast(`Generated ${made} thumbnail${made > 1 ? 's' : ''}.`, "success");
      scheduleProjectSave();
    }
  } finally {
    btn.disabled = false;
    btn.innerText = 'Generate Thumbnails';
  }
}

/* ---------------- YouTube chapter markers ---------------- */

// Whole-second "MM:SS" stamp (YouTube's chapter format)
function chapterStamp(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

// Short human title for a scene: SEO kit's chapter titles → narration → prompt excerpt
function shortSceneTitle(scene, i) {
  const kit = state.lastSEOKit;
  if (kit && kit.chapterTitles && kit.chapterTitles[i]) return kit.chapterTitles[i];
  const src = (scene.narration || scene.prompt || '').replace(/\s+/g, ' ').trim();
  if (!src) return `Scene ${i + 1}`;
  const words = src.split(' ');
  return words.slice(0, 6).join(' ').replace(/[.,;:!?]+$/, '') + (words.length > 6 ? '…' : '');
}

// Chapter list matching the FINAL render timeline: intro card, then only the
// scenes that will actually be compiled, then the outro. Enforces YouTube's
// rules: first chapter at 00:00 and no chapter shorter than 10 seconds
// (too-short segments are absorbed into the previous chapter).
function buildChapterMarkers() {
  const valid = state.scenes.filter(s => s.generatedUrl);
  if (valid.length === 0) return '';

  const intro = getNLEIntroDuration();
  const candidates = [];
  if (intro > 0) candidates.push({ t: 0, title: 'Intro' });

  let t = intro;
  state.scenes.forEach((s, i) => {
    if (!s.generatedUrl) return;
    const dur = s.start && s.end
      ? Math.max(0.5, timeToSeconds(s.end) - timeToSeconds(s.start))
      : 10;
    candidates.push({ t, title: shortSceneTitle(s, i) });
    t += dur;
  });
  if (getNLEOutroDuration() > 0) candidates.push({ t, title: 'Outro — Subscribe!' });

  const chapters = [];
  candidates.forEach(c => {
    if (chapters.length === 0) { chapters.push({ t: 0, title: c.title }); return; }
    const prev = chapters[chapters.length - 1];
    if (c.t - prev.t < 10) {
      // Too short for YouTube — merge, preferring the more descriptive title
      if (prev.title === 'Intro') prev.title = c.title;
      return;
    }
    chapters.push({ ...c });
  });

  return chapters.map(c => `${chapterStamp(c.t)} ${c.title}`).join('\n');
}

// Fill the Publish-step chapters box (kept editable; only overwrites on demand)
function refreshChapterUI(force = false) {
  const box = document.getElementById('chapterText');
  const status = document.getElementById('chapterStatus');
  if (!box) return;
  const built = buildChapterMarkers();
  if (force || !box.value.trim()) box.value = built;
  if (status) {
    const count = box.value.trim() ? box.value.trim().split('\n').length : 0;
    if (!count) {
      status.innerText = 'No timed scenes yet — generate the storyboard first.';
      status.style.color = 'var(--color-text-muted)';
    } else if (count < 3) {
      status.innerText = `${count} chapter(s) — YouTube shows the chapter bar from 3 chapters up.`;
      status.style.color = 'var(--color-warning)';
    } else {
      status.innerText = `${count} chapters ready — appended to the description on upload.`;
      status.style.color = 'var(--color-success)';
    }
  }
}

// Append the chapters block to a description (once — never duplicates)
function withChapters(description) {
  const box = document.getElementById('chapterText');
  const chapters = box && box.value.trim() ? box.value.trim() : buildChapterMarkers();
  if (!chapters) return description;
  const firstLine = chapters.split('\n')[0];
  if (description.includes(firstLine)) return description; // already there
  return `${description.trim()}\n\nCHAPTERS:\n${chapters}`.trim();
}

/* ---------------- Auto-Shorts ---------------- */

function renderShortsGrid() {
  const grid = document.getElementById('shortsGrid');
  const status = document.getElementById('shortsStatus');
  if (!grid) return;
  if (status) {
    if (!state.lastRender || !state.lastRender.filename) {
      status.innerText = 'Render the master video in the Studio first.';
      status.style.color = 'var(--color-text-muted)';
    } else if (state.shorts.length) {
      status.innerText = `${state.shorts.length} Short(s) ready — download and upload as YouTube Shorts / Reels.`;
      status.style.color = 'var(--color-success)';
    } else {
      status.innerText = 'Master render found — generate your Shorts.';
      status.style.color = 'var(--color-text-muted)';
    }
  }
  grid.innerHTML = (state.shorts || []).map((s, i) => `
    <div class="short-item">
      <video src="${s.url}" controls muted playsinline preload="metadata"></video>
      <div class="short-meta">
        <strong>${escapeHtml(s.title || `Short ${i + 1}`)}</strong>
        <span class="short-window">${s.startSec}s → ${s.endSec}s · ${s.duration}s</span>
        ${s.reason ? `<span class="short-reason">${escapeHtml(s.reason)}</span>` : ''}
        <div class="btn-row" style="display:flex; gap:0.4rem; margin-top:0.4rem;">
          <a class="btn btn-secondary btn-sm" href="${s.url}" download="${s.filename}">Download</a>
          <button class="btn btn-secondary btn-sm" data-copy-short="${i}">Copy Title</button>
        </div>
      </div>
    </div>`).join('');
  grid.querySelectorAll('[data-copy-short]').forEach(b => {
    b.addEventListener('click', () => {
      const s = state.shorts[parseInt(b.dataset.copyShort, 10)];
      if (!s) return;
      navigator.clipboard.writeText(`${s.title} #shorts`);
      showToast('Shorts title copied (with #shorts).', 'success');
    });
  });
}

async function generateShorts() {
  if (!state.lastRender || !state.lastRender.filename) {
    showToast('Render the master video in the Studio first.', 'warning');
    return;
  }
  const btn = document.getElementById('btnGenerateShorts');
  const status = document.getElementById('shortsStatus');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> Cutting Shorts…';
  if (status) { status.innerText = 'AI is picking the best moments and cutting vertical clips…'; status.style.color = 'var(--color-text-muted)'; }
  try {
    // Timed lines shifted onto the FINAL video timeline (after the intro card)
    const intro = getNLEIntroDuration();
    const lines = getLyricsBlocks().map(l => ({
      text: l.text,
      start: intro + l.startTime,
      end: intro + l.startTime + l.duration
    }));
    const res = await fetch('/api/generate-shorts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoFilename: state.lastRender.filename,
        lines,
        count: parseInt(getInputValue('shortsCount'), 10) || 2,
        style: getInputValue('shortsStyle') || 'blur',
        topic: (state.explainer && state.explainer.topic) || (nleIntroTitle && nleIntroTitle.value) || ''
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Shorts generation failed');
    state.shorts = data.shorts || [];
    renderShortsGrid();
    scheduleProjectSave();
    showToast(`${state.shorts.length} Short(s) ready${data.aiSelected ? ' — AI picked the best moments' : ''}.`, 'success');
  } catch (err) {
    console.error(err);
    if (status) { status.innerText = `Shorts failed: ${err.message}`; status.style.color = 'var(--color-warning)'; }
    showToast(`Shorts generation failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Generate Shorts';
  }
}

// Assemble youtube-metadata.txt from the last SEO kit
function buildYouTubeMetadata() {
  const kit = state.lastSEOKit;
  const lines = [];
  const videoTitle = (state.explainer && state.explainer.videoTitle) || (nleIntroTitle && nleIntroTitle.value) || '';
  lines.push('=== OMNISTUDIO PUBLISH METADATA ===', '');
  if (kit && kit.titles && kit.titles.length) {
    lines.push('TITLE OPTIONS:', ...kit.titles.map(t => `  - ${t}`), '');
  } else if (videoTitle) {
    lines.push(`TITLE: ${videoTitle}`, '');
  }
  if (kit && kit.description) lines.push('DESCRIPTION:', kit.description, '');
  if (kit && kit.tags && kit.tags.length) lines.push('TAGS (paste into the tags field):', kit.tags.join(', '), '');
  if (kit && kit.hashtags && kit.hashtags.length) lines.push('HASHTAGS:', kit.hashtags.join(' '), '');
  const chapterBox = document.getElementById('chapterText');
  const chapterList = (chapterBox && chapterBox.value.trim()) || buildChapterMarkers();
  if (chapterList) {
    lines.push('CHAPTERS (append to the description):', chapterList, '');
  }
  lines.push('Remember: tick "altered or synthetic content" in the YouTube upload flow (AI-generated).');
  return lines.join('\n');
}

// Archive the finished video's deliverables to the organized GCS library
async function archiveToCloudLibrary() {
  if (!state.lastRender || !state.lastRender.filename) {
    showToast('Render the master video in the Studio first.', 'warning');
    return;
  }
  const btn = document.getElementById('btnArchiveLibrary');
  const status = document.getElementById('archiveStatus');
  btn.disabled = true;
  btn.innerText = 'Archiving…';
  try {
    let channelName = '';
    if (state.channelId) {
      const channels = await getChannelList();
      const ch = channels.find(c => c.id === state.channelId);
      if (ch) channelName = ch.name;
    }
    const title = (state.lastSEOKit && state.lastSEOKit.titles && state.lastSEOKit.titles[0]) ||
      (state.explainer && state.explainer.videoTitle) ||
      (nleIntroTitle && nleIntroTitle.value) || 'video';

    const res = await fetch('/api/archive-render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelName,
        title,
        videoFilename: state.lastRender.filename,
        thumbnailFilenames: (state.thumbnails || []).map(t => t.filename),
        shortFilenames: (state.shorts || []).map(s => s.filename),
        srtContent: buildSRTContent(),
        metadataContent: buildYouTubeMetadata()
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'archive failed');
    if (status) {
      status.innerText = `Archived ${data.archived} file(s) → ${data.path}`;
      status.style.color = 'var(--color-success)';
    }
    showToast(`Cloud library updated: ${data.archived} file(s) archived.`, 'success');
  } catch (err) {
    if (status) { status.innerText = `Archive failed: ${err.message}`; status.style.color = 'var(--color-warning)'; }
    showToast(`Cloud archive failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = '☁️ Archive to Cloud Library';
  }
}

function updatePackageStatus() {
  const status = document.getElementById('packageStatus');
  if (!status) return;
  if (state.lastRender && state.lastRender.filename) {
    const extras = [buildSRTContent() ? 'subtitles.srt' : null, state.lastSEOKit ? 'youtube-metadata.txt' : null, state.thumbnails.length ? `${state.thumbnails.length} thumbnail(s)` : null].filter(Boolean);
    status.innerText = `Ready: ${state.lastRender.filename}${extras.length ? ' + ' + extras.join(' + ') : ''}`;
    status.style.color = 'var(--color-success)';
  } else {
    status.innerText = 'Render the video in the Studio first.';
    status.style.color = 'var(--color-text-muted)';
  }
}

async function exportPublishPackage() {
  if (!state.lastRender || !state.lastRender.filename) {
    showToast("Render the master video in the Studio first.", "warning");
    return;
  }

  const btn = document.getElementById('btnExportPackage');
  btn.disabled = true;
  btn.innerText = 'Packing…';

  try {
    const res = await fetch('/api/export-package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoFilename: state.lastRender.filename,
        srtContent: buildSRTContent(),
        metadataContent: buildYouTubeMetadata(),
        thumbnailFilenames: (state.thumbnails || []).map(t => t.filename)
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Package export failed');
    }
    const data = await res.json();

    const a = document.createElement('a');
    a.href = data.url;
    a.download = 'publish_package.zip';
    a.click();
    showToast(`Publish package ready (${data.files} files). Everything you need to upload.`, "success");
  } catch (error) {
    console.error(error);
    showToast(`Package export failed: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerText = 'Download Publish Package (.zip)';
  }
}

/* ==========================================================================
   Output Orientation (Landscape 16:9 / Vertical 9:16)
   ========================================================================== */

function setOrientation(orientation) {
  state.orientation = orientation === 'vertical' ? 'vertical' : 'landscape';

  const toggle = document.getElementById('orientationToggle');
  if (toggle) {
    toggle.querySelectorAll('.orientation-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.orientation === state.orientation);
    });
  }

  const wrapper = document.getElementById('nleCanvasWrapper');
  if (wrapper) wrapper.classList.toggle('vertical', state.orientation === 'vertical');

  scheduleProjectSave();
}

/* ==========================================================================
   Title Card Images
   ========================================================================== */

// Downscale an image file to a compact JPEG data URL (keeps localStorage saves small)
function downscaleImageFile(file, maxDim = 640) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Reflect a stored card image in its thumbnail controls
// A card image is either a data URL string (upload) or { filename, url } (AI-generated)
function getCardImageSrc(which) {
  const v = state.cardImages[which];
  if (!v) return null;
  return typeof v === 'string' ? v : (v.url || null);
}

function getCardImagePayload(which) {
  const v = state.cardImages[which];
  if (!v) return {};
  return typeof v === 'string'
    ? { imageBase64: v }
    : { imageFilename: v.filename, hideText: !!v.bakedText };
}

function updateCardImageUI(which, thumbId, removeBtnId) {
  const thumb = document.getElementById(thumbId);
  const removeBtn = document.getElementById(removeBtnId);
  const src = getCardImageSrc(which);
  if (thumb) {
    thumb.src = src || '';
    thumb.style.display = src ? 'block' : 'none';
  }
  if (removeBtn) removeBtn.style.display = src ? 'inline-block' : 'none';
}

/* ---------------- Channel brand kits ---------------- */

let channelListCache = null;
async function getChannelList(force) {
  if (channelListCache && !force) return channelListCache;
  try {
    const res = await fetch('/api/planner');
    channelListCache = (await res.json()).channels || [];
  } catch {
    channelListCache = [];
  }
  return channelListCache;
}

async function populateProjectChannelSelect() {
  const sel = document.getElementById('projectChannel');
  if (!sel) return;
  const channels = await getChannelList(true);
  sel.innerHTML = '<option value="">No channel</option>' +
    channels.map(c => `<option value="${c.id}" ${c.id === state.channelId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  updateChannelBrandInfo();
  updateLogoUI();
}

async function updateChannelBrandInfo() {
  const el = document.getElementById('channelBrandInfo');
  if (!el) return;
  if (!state.channelId) { el.style.display = 'none'; return; }
  const channels = await getChannelList();
  const ch = channels.find(c => c.id === state.channelId);
  if (!ch) { el.style.display = 'none'; return; }
  const hasKit = ch.brandRefs && ch.brandRefs.length > 0;
  el.innerText = hasKit
    ? `Channel kit active: "${ch.name}" — AI images will match its brand art.`
    : `Channel "${ch.name}" has no brand art yet — set it with the 🎨 button on its chip in the Planner.`;
  el.style.color = hasKit ? 'var(--color-success)' : 'var(--color-text-muted)';
  el.style.display = 'block';
}

/* ---------------- Brand reference (album cover / character art) ---------------- */

function updateBrandUI() {
  const thumb = document.getElementById('brandThumb');
  const removeBtn = document.getElementById('btnBrandRemove');
  if (thumb) {
    thumb.src = state.brandRef || '';
    thumb.style.display = state.brandRef ? 'block' : 'none';
  }
  if (removeBtn) removeBtn.style.display = state.brandRef ? 'inline-block' : 'none';
}

// Gather style/character references for image generation, in priority order:
// channel brand kit → project-level reference → active character images.
async function collectStyleRefs() {
  const refs = [];
  if (state.channelId) {
    try {
      const channels = await getChannelList();
      const ch = channels.find(c => c.id === state.channelId);
      for (const f of ((ch && ch.brandRefs) || []).slice(0, 3)) {
        refs.push(await urlToBase64(`/outputs/${f}`));
      }
    } catch (err) {
      console.warn('Channel brand kit unavailable:', err);
    }
  }
  if (state.brandRef) refs.push(state.brandRef);
  if (state.mode === 'music' && state.activeCharacter) {
    try {
      if (state.activeCharacter.type === 'custom' && state.activeCharacter.data) {
        refs.push(state.activeCharacter.data);
        if (state.activeCharacter.views && state.activeCharacter.views[0]) {
          refs.push(state.activeCharacter.views[0]);
        }
      } else if (state.activeCharacter.fileUrl) {
        refs.push(await urlToBase64(state.activeCharacter.fileUrl));
      }
    } catch (err) {
      console.warn('Character reference unavailable:', err);
    }
  }
  return refs.slice(0, 4);
}

/* ---------------- Channel logo watermark ---------------- */

// The channel's logo wins; a project-level logo is the fallback for unlinked projects.
async function resolveLogo() {
  if (state.channelId) {
    try {
      const channels = await getChannelList();
      const ch = channels.find(c => c.id === state.channelId);
      if (ch && ch.logo) return { filename: ch.logo, url: `/outputs/${ch.logo}`, source: 'channel' };
    } catch (err) {
      console.warn('Channel logo unavailable:', err);
    }
  }
  if (state.projectLogo && state.projectLogo.filename) {
    return { filename: state.projectLogo.filename, url: `/outputs/${state.projectLogo.filename}`, source: 'project' };
  }
  if (state.projectLogo && state.projectLogo.dataUrl) {
    return { dataUrl: state.projectLogo.dataUrl, url: state.projectLogo.dataUrl, source: 'project' };
  }
  return null;
}

// Sync the Polish-tab logo controls and the always-on preview overlay
async function updateLogoUI() {
  const overlay = document.getElementById('nleLogoOverlay');
  const thumb = document.getElementById('logoThumb');
  const status = document.getElementById('logoStatus');
  const logo = await resolveLogo();
  const enabled = !!getInputValue('logoEnabled');

  if (thumb) {
    thumb.src = logo ? logo.url : '';
    thumb.style.display = logo ? 'block' : 'none';
  }
  if (status) {
    status.innerText = logo
      ? (logo.source === 'channel' ? 'Channel logo active.' : 'Project logo ready.')
      : 'No logo yet — generate one with AI or upload it.';
  }
  if (overlay) {
    if (enabled && logo) {
      overlay.src = logo.url;
      overlay.className = 'nle-logo-overlay pos-' + (getInputValue('logoPosition') || 'top-right');
      overlay.style.width = `${(parseFloat(getInputValue('logoSize')) || 0.12) * 100}%`;
      overlay.style.opacity = getInputValue('logoOpacity') || '0.85';
      overlay.style.display = 'block';
    } else {
      overlay.style.display = 'none';
    }
  }
}

// Build the render payload for the watermark (null when disabled or no logo)
async function getLogoPayload() {
  if (!getInputValue('logoEnabled')) return null;
  const logo = await resolveLogo();
  if (!logo) return null;
  return {
    filename: logo.filename || null,
    imageBase64: logo.dataUrl || null,
    position: getInputValue('logoPosition') || 'top-right',
    size: parseFloat(getInputValue('logoSize')) || 0.12,
    opacity: parseFloat(getInputValue('logoOpacity')) || 0.85
  };
}

async function generateLogoFlow() {
  const btn = document.getElementById('btnGenerateLogo');
  btn.disabled = true;
  btn.innerText = 'Generating…';
  showToast("Designing your channel logo with AI…", "info");
  try {
    let channelName = '', niche = '';
    if (state.channelId) {
      const channels = await getChannelList();
      const ch = channels.find(c => c.id === state.channelId);
      if (ch) { channelName = ch.name; niche = ch.niche || ch.description || ''; }
    }
    if (!channelName) {
      channelName = (nleIntroSubtitle && nleIntroSubtitle.value.trim()) ||
        (state.explainer && state.explainer.topic) || 'My Channel';
    }
    const referenceImages = await collectStyleRefs();

    const res = await fetch('/api/generate-logo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: state.channelId, channelName, niche, referenceImages })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Logo generation failed');
    const data = await res.json();

    if (state.channelId) {
      await getChannelList(true); // channel.logo just changed server-side
    } else {
      state.projectLogo = { filename: data.filename };
    }
    setInputValue('logoEnabled', true);
    await updateLogoUI();
    scheduleProjectSave();
    showToast("Logo ready! It will stay on screen for the whole video.", "success");
  } catch (err) {
    console.error(err);
    showToast(`Logo generation failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerText = '✦ Generate Logo (AI)';
  }
}

// Read as-is (no canvas re-encode) so PNG transparency survives
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

async function uploadLogoFile(file) {
  const dataUrl = await readFileAsDataURL(file);
  if (state.channelId) {
    const res = await fetch('/api/channel-logo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: state.channelId, imageBase64: dataUrl })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
    await getChannelList(true);
  } else {
    state.projectLogo = { dataUrl };
  }
  setInputValue('logoEnabled', true);
  await updateLogoUI();
  scheduleProjectSave();
}

// Generate a cinematic AI background for a card (no baked-in text; card overlays its own)
async function generateCardBackground(which) {
  const btn = document.getElementById(which === 'intro' ? 'btnIntroAIBg' : 'btnOutroAIBg');
  const titleEl = which === 'intro' ? nleIntroTitle : nleOutroTitle;
  const cardTitle = titleEl ? titleEl.value.trim() : '';
  const topic = (state.explainer && state.explainer.topic) || cardTitle || 'the video';

  btn.disabled = true;
  btn.innerText = 'Generating…';
  showToast(`Generating AI cover background for the ${which} card…`, 'info');
  try {
    const referenceImages = await collectStyleRefs();

    let channelName = '';
    let channelNiche = '';
    if (state.channelId) {
      try {
        const channels = await getChannelList();
        const ch = channels.find(c => c.id === state.channelId);
        if (ch) {
          channelName = ch.name;
          channelNiche = ch.niche || ch.description || '';
        }
      } catch (e) {}
    }
    
    const packagePrompt = state.lastSEOKit && state.lastSEOKit[
      which === 'intro' ? 'introBackgroundPrompt' : 'outroBackgroundPrompt'
    ];
    let concept = packagePrompt || `High-impact YouTube packaging for this specific video: ${topic}. One dominant expressive focal subject, a strong emotional reaction or surprising reveal, and immediate phone-size readability.`;
    if (which === 'intro') {
      const lyricsEl = document.getElementById('lyricsInput');
      const lyrics = lyricsEl ? lyricsEl.value.trim() : '';
      if (!packagePrompt && lyrics) {
        concept += ` Visually interpret the storytelling, mood, and characters of these song lyrics: "${lyrics.slice(0, 700)}".`;
      }
    }

    const res = await fetch('/api/generate-thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        concept,
        videoTitle: cardTitle,
        seoTitle: (state.lastSEOKit && state.lastSEOKit.titles && state.lastSEOKit.titles[0]) || cardTitle,
        cardRole: which,
        cardTitle,
        cardSubtitle: which === 'intro'
          ? (nleIntroSubtitle ? nleIntroSubtitle.value.trim() : '')
          : (nleOutroCTA ? nleOutroCTA.value.trim() : ''),
        orientation: state.orientation,
        kind: 'card-bg',
        referenceImages,
        channelName,
        channelNiche
      })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'generation failed');
    const data = await res.json();

    state.cardImages[which] = { filename: data.filename, url: data.url, bakedText: true };
    const modeSel = document.getElementById(which === 'intro' ? 'introImageMode' : 'outroImageMode');
    if (modeSel) modeSel.value = 'background';
    const hideTxtChk = document.getElementById(which === 'intro' ? 'introHideText' : 'outroHideText');
    if (hideTxtChk) hideTxtChk.checked = true;
    updateCardImageUI(which, `${which}ImageThumb`, `btn${which === 'intro' ? 'Intro' : 'Outro'}ImageRemove`);
    updateTitleCardOverlay(nleState.currentTime);
    scheduleProjectSave();
    showToast(`${which === 'intro' ? 'Intro' : 'Outro'} card now has an AI cover background.`, 'success');
    return true;
  } catch (err) {
    console.error(err);
    showToast(`AI background failed: ${err.message}`, 'error');
    return false;
  } finally {
    btn.disabled = false;
    btn.innerText = '✦ AI Background';
  }
}

function setupCardImagePicker(which, pickBtnId, inputId, thumbId, removeBtnId) {
  const pickBtn = document.getElementById(pickBtnId);
  const input = document.getElementById(inputId);
  const removeBtn = document.getElementById(removeBtnId);
  if (!pickBtn || !input) return;

  pickBtn.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    if (!file.type.startsWith('image/')) {
      showToast("Please choose an image file.", "error");
      return;
    }
    try {
      state.cardImages[which] = await downscaleImageFile(file);
      updateCardImageUI(which, thumbId, removeBtnId);
      updateTitleCardOverlay(nleState.currentTime);
      scheduleProjectSave();
      showToast(`${which === 'intro' ? 'Intro' : 'Outro'} card image added.`, "success");
    } catch (err) {
      console.error(err);
      showToast("Could not read that image.", "error");
    } finally {
      input.value = '';
    }
  });

  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      state.cardImages[which] = null;
      updateCardImageUI(which, thumbId, removeBtnId);
      updateTitleCardOverlay(nleState.currentTime);
      scheduleProjectSave();
    });
  }
}

/* ==========================================================================
   Continuity Agent — reviews scene prompts for coherence before generation
   ========================================================================== */

async function runCoherenceCheck(silent) {
  // Sync any prompt edits from the storyboard textareas first
  state.scenes.forEach((scene, i) => {
    const input = document.getElementById(`scene-input-${i}`);
    if (input && input.value.trim()) scene.prompt = input.value.trim();
  });

  if (state.scenes.filter(s => s.prompt).length < 2) {
    if (!silent) showToast("Need at least 2 scenes with prompts to review continuity.", "warning");
    return 0;
  }

  const btn = document.getElementById('btnCoherenceCheck');
  if (btn) {
    btn.disabled = true;
    btn.innerText = "Reviewing Continuity...";
  }
  if (!silent) showToast("Continuity agent is reviewing your scene sequence...", "info");

  try {
    const res = await fetch('/api/review-coherence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenes: state.scenes.map(s => ({
          prompt: s.prompt,
          narration: s.narration || null,
          newBackground: s.newBackground !== false
        })),
        characterName: state.mode === 'music' && state.activeCharacter ? state.activeCharacter.name : null,
        topic: state.explainer ? state.explainer.topic : null,
        style: state.mode === 'explainer' && explainerStyle ? explainerStyle.value : '3D claymation style'
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Continuity review failed");
    }

    const data = await res.json();
    let fixedCount = 0;

    (data.scenes || []).forEach(review => {
      const scene = state.scenes[(review.sceneNumber || 0) - 1];
      if (!scene) return;
      if (!review.coherent && review.revisedPrompt && review.revisedPrompt.trim()) {
        scene.prompt = review.revisedPrompt.trim();
        scene.coherenceIssue = review.issue || 'Adjusted for continuity';
        scene.coherenceRevised = true;
        fixedCount++;
      }
    });

    if (fixedCount > 0) {
      renderStoryboard();
      showToast(`Continuity agent revised ${fixedCount} prompt${fixedCount > 1 ? 's' : ''} for coherence. ${data.overallAssessment || ''}`, "success");
    } else if (!silent) {
      showToast(`Continuity check passed — all scenes are coherent. ${data.overallAssessment || ''}`, "success");
    }

    scheduleProjectSave();
    return fixedCount;
  } catch (error) {
    console.error(error);
    if (!silent) showToast(`Continuity check failed: ${error.message}`, "error");
    return 0;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = "Continuity Check";
    }
  }
}

// Review a single generated clip; stores result on scene.realism and returns it
async function reviewSceneRealism(scene) {
  scene.realismChecking = true;
  updateSceneRealismUI(scene.index);
  try {
    const res = await fetch('/api/review-video-realism', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: scene.filename, prompt: scene.prompt })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Realism review failed');
    }
    const r = await res.json();
    scene.realism = {
      score: r.realismScore,
      coherent: r.coherent,
      issues: r.issues || [],
      fix: r.suggestedFix || '',
      summary: r.summary || ''
    };
  } catch (err) {
    console.error(`Realism check failed for scene ${scene.index + 1}:`, err);
    scene.realism = { error: err.message };
  } finally {
    scene.realismChecking = false;
    updateSceneRealismUI(scene.index);
  }
  return scene.realism;
}

// Video realism agent — watches each GENERATED clip for real-world implausibility
async function runRealismCheck() {
  const generated = state.scenes.filter(s => s.generatedUrl && s.filename);
  if (generated.length === 0) {
    showToast("Generate at least one scene first — this agent reviews the actual video clips.", "warning");
    return;
  }

  const btn = document.getElementById('btnRealismCheck');
  btn.disabled = true;
  let flagged = 0;

  try {
    for (let i = 0; i < generated.length; i++) {
      btn.innerText = `Watching clip ${i + 1}/${generated.length}...`;
      const r = await reviewSceneRealism(generated[i]);
      if (r && !r.error && !r.coherent) flagged++;
    }

    if (flagged > 0) {
      showToast(`Realism agent flagged ${flagged} clip${flagged > 1 ? 's' : ''}. Review the notes and apply a fix to regenerate.`, "warning");
    } else {
      showToast("Realism agent watched every clip — all look physically plausible.", "success");
    }
    scheduleProjectSave();
  } finally {
    btn.disabled = false;
    btn.innerText = "Check Video Realism";
  }
}

// Hands-off pass: review all clips, then auto-fix + regenerate low-scoring ones ONCE
async function autoRealismPass() {
  const thresholdInput = document.getElementById('realismThreshold');
  const threshold = Math.max(1, Math.min(9, parseInt(thresholdInput ? thresholdInput.value : '6', 10) || 6));

  const btn = document.getElementById('btnGenerateAll');
  const generated = () => state.scenes.filter(s => s.generatedUrl && s.filename);

  // Pass 1: review everything
  const clips = generated();
  for (let i = 0; i < clips.length; i++) {
    if (btn) btn.innerText = `Realism check ${i + 1}/${clips.length}...`;
    await reviewSceneRealism(clips[i]);
  }

  // Pass 2: auto-fix clips that scored below the threshold (each fixed at most once)
  const lowScoring = state.scenes.filter(s =>
    s.realism && !s.realism.error && s.realism.fix &&
    (s.realism.score < threshold) && !s.realismAutoFixed
  );

  if (lowScoring.length === 0) {
    showToast(`Realism pass complete — every clip scored ${threshold}/10 or higher.`, "success");
    scheduleProjectSave();
    return;
  }

  showToast(`Auto-fixing ${lowScoring.length} clip${lowScoring.length > 1 ? 's' : ''} that scored below ${threshold}...`, "info");

  for (let i = 0; i < lowScoring.length; i++) {
    const scene = lowScoring[i];
    if (btn) btn.innerText = `Auto-fixing clip ${scene.index + 1} (${i + 1}/${lowScoring.length})...`;

    // Append the agent's fix to the prompt (once), then regenerate that clip
    const fix = scene.realism.fix.trim();
    scene.prompt = scene.prompt.includes(fix) ? scene.prompt : `${scene.prompt}. ${fix}`;
    const input = document.getElementById(`scene-input-${scene.index}`);
    if (input) input.value = scene.prompt;
    scene.realismAutoFixed = true;
    scene.realism = null;
    updateSceneRealismUI(scene.index);

    await generateScene(scene.index);

    // Re-review the regenerated clip so the user sees the outcome
    if (state.scenes[scene.index].generatedUrl) {
      await reviewSceneRealism(state.scenes[scene.index]);
    }
  }

  const stillLow = state.scenes.filter(s => s.realism && !s.realism.error && s.realism.score < threshold).length;
  if (stillLow > 0) {
    showToast(`Auto-fix done. ${stillLow} clip${stillLow > 1 ? 's' : ''} still below ${threshold} — review manually or regenerate.`, "warning");
  } else {
    showToast("Auto-fix complete — all clips now meet the realism threshold.", "success");
  }
  scheduleProjectSave();
}

// Render the realism badge/note for one scene card without a full storyboard re-render
function updateSceneRealismUI(index) {
  const card = document.getElementById(`scene-card-${index}`);
  if (!card) return;
  const scene = state.scenes[index];

  let holder = card.querySelector('.realism-note');
  if (!holder) {
    holder = document.createElement('div');
    holder.className = 'realism-note';
    const videoSlot = document.getElementById(`video-slot-${index}`);
    if (videoSlot && videoSlot.parentNode) {
      videoSlot.parentNode.insertBefore(holder, videoSlot.nextSibling);
    } else {
      card.appendChild(holder);
    }
  }

  if (scene.realismChecking) {
    holder.className = 'realism-note checking';
    holder.innerHTML = `Realism agent is watching this clip…`;
    return;
  }

  const r = scene.realism;
  if (!r) { holder.remove(); return; }

  if (r.error) {
    holder.className = 'realism-note error';
    holder.innerHTML = `Realism check unavailable: ${escapeHtml(r.error)}`;
    return;
  }

  if (r.coherent) {
    holder.className = 'realism-note ok';
    holder.innerHTML = `Realism ${r.score}/10 — ${escapeHtml(r.summary)}`;
  } else {
    holder.className = 'realism-note warn';
    const issues = (r.issues || []).map(escapeHtml).join(' · ');
    holder.innerHTML = `
      <div><strong>Realism ${r.score}/10</strong> — ${escapeHtml(r.summary)}</div>
      ${issues ? `<div class="realism-issues">${issues}</div>` : ''}
      ${r.fix ? `<button class="btn btn-secondary btn-sm realism-fix-btn" data-idx="${index}">Apply fix &amp; regenerate</button>` : ''}
    `;
    const fixBtn = holder.querySelector('.realism-fix-btn');
    if (fixBtn) fixBtn.addEventListener('click', () => applyRealismFix(index));
  }
}

// Append the agent's fix to the prompt and regenerate that single scene
async function applyRealismFix(index) {
  const scene = state.scenes[index];
  if (!scene || !scene.realism || !scene.realism.fix) return;

  const input = document.getElementById(`scene-input-${index}`);
  const basePrompt = (input && input.value.trim()) ? input.value.trim() : scene.prompt;
  // Avoid stacking the same fix twice
  const fix = scene.realism.fix.trim();
  scene.prompt = basePrompt.includes(fix) ? basePrompt : `${basePrompt}. ${fix}`;
  if (input) input.value = scene.prompt;

  scene.realism = null; // stale once we regenerate
  updateSceneRealismUI(index);
  showToast(`Applied realism fix to Scene ${index + 1}, regenerating…`, "info");
  await generateScene(index);
}

/* ==========================================================================
   Music Master — intelligent mastering engine (Mixea-style)
   ========================================================================== */

function renderMasterUI() {
  const nameEl = document.getElementById('masterSourceName');
  if (nameEl) {
    nameEl.innerText = state.masterTrack
      ? `Loaded: ${state.masterTrack.displayName || state.masterTrack.filename} (${state.masterTrack.duration ? state.masterTrack.duration + 's' : 'ready'})`
      : 'No track loaded yet.';
    nameEl.style.color = state.masterTrack ? 'var(--color-success)' : 'var(--color-text-muted)';
  }

  const resultBox = document.getElementById('masterResult');
  if (!resultBox) return;
  if (state.masterTrack && state.masterResult) {
    const a = document.getElementById('masterAudioA');
    const b = document.getElementById('masterAudioB');
    if (a && !a.src.endsWith(state.masterTrack.filename)) a.src = `/outputs/${state.masterTrack.filename}`;
    if (b && !b.src.endsWith(state.masterResult.filename)) b.src = `/outputs/${state.masterResult.filename}`;
    const dl = document.getElementById('masterDownload');
    if (dl) { dl.href = state.masterResult.url; dl.download = state.masterResult.filename; }
    renderMasterReport(state.masterResult.report);
    resultBox.style.display = 'block';
  } else {
    resultBox.style.display = 'none';
  }
}

function renderMasterReport(report) {
  const el = document.getElementById('masterReport');
  if (!el || !report) return;
  const fmt = (v) => (v === null || v === undefined || isNaN(v)) ? '—' : v.toFixed(1);
  el.innerHTML = `
    <table class="report-table">
      <tr><th></th><th>Before</th><th>After</th><th>Target</th></tr>
      <tr><td>Loudness (LUFS)</td><td>${fmt(report.before.lufs)}</td><td class="good">${fmt(report.after.lufs)}</td><td>${report.targetLufs}</td></tr>
      <tr><td>True Peak (dBTP)</td><td>${fmt(report.before.truePeak)}</td><td class="good">${fmt(report.after.truePeak)}</td><td>≤ −1.0</td></tr>
      <tr><td>Dynamics (LRA)</td><td>${fmt(report.before.lra)}</td><td>${fmt(report.after.lra)}</td><td>—</td></tr>
    </table>
    <p class="inspector-hint" style="margin-top: 0.5rem;">Style: ${escapeHtml(report.style)}${report.widened ? ' · stereo enhanced' : ''} · measured two-pass correction, not a blind preset.</p>
  `;
}

async function handleMasterUpload() {
  const input = document.getElementById('masterFileInput');
  if (!input.files || input.files.length === 0) return;
  const file = input.files[0];
  if (!file.type.startsWith('audio/')) {
    showToast("Please choose an audio file.", "error");
    return;
  }

  const status = document.getElementById('masterStatus');
  if (status) { status.innerText = 'Uploading track…'; status.style.color = 'var(--color-text-muted)'; }

  const formData = new FormData();
  formData.append('audio', file);
  try {
    const res = await fetch('/api/upload-audio', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    const data = await res.json();
    state.masterTrack = { filename: data.filename, duration: Math.round(data.duration * 10) / 10, displayName: file.name };
    state.masterResult = null;
    renderMasterUI();
    if (status) status.innerText = '';
    showToast(`"${file.name}" loaded. Pick a style and hit Master Track.`, "success");
    scheduleProjectSave();
  } catch (err) {
    console.error(err);
    if (status) { status.innerText = `Upload failed: ${err.message}`; status.style.color = 'var(--color-warning)'; }
  } finally {
    input.value = '';
  }
}

function useProjectTrackForMaster() {
  if (!state.audio) {
    showToast("The current project has no audio track yet (upload or generate one first).", "warning");
    return;
  }
  state.masterTrack = { filename: state.audio.filename, duration: state.audio.duration, displayName: 'Current project track' };
  state.masterResult = null;
  renderMasterUI();
  showToast("Project track loaded into the mastering engine.", "success");
  scheduleProjectSave();
}

async function masterTrackNow() {
  if (!state.masterTrack) {
    showToast("Load a track first — upload one or use the current project track.", "warning");
    return;
  }

  const btn = document.getElementById('btnMasterTrack');
  const status = document.getElementById('masterStatus');
  btn.disabled = true;
  btn.innerText = 'Analyzing & Mastering…';
  if (status) { status.innerText = 'Pass 1: measuring loudness · Pass 2: EQ, compression and exact correction…'; status.style.color = 'var(--color-text-muted)'; }

  try {
    const res = await fetch('/api/master-track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: state.masterTrack.filename,
        style: getInputValue('masterStyle') || 'balanced',
        targetLufs: parseFloat(getInputValue('masterTarget')) || -14,
        widen: !!getInputValue('masterWiden')
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Mastering failed');
    }
    const data = await res.json();
    state.masterResult = { filename: data.filename, url: data.url, report: data.report };
    renderMasterUI();
    if (status) status.innerText = '';
    showToast(`Mastered to ${data.report.after.lufs.toFixed(1)} LUFS (${data.report.style}). Compare A/B below.`, "success");
    scheduleProjectSave();
  } catch (err) {
    console.error(err);
    if (status) { status.innerText = `Mastering failed: ${err.message}`; status.style.color = 'var(--color-warning)'; }
    showToast(`Mastering failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerText = 'Master Track';
  }
}

function useMasteredAsProjectAudio() {
  if (!state.masterResult) return;
  state.audio = { filename: state.masterResult.filename, duration: state.masterTrack ? state.masterTrack.duration : 60 };
  if (nleAudioElement) nleAudioElement.src = `/outputs/${state.masterResult.filename}`;
  nleState.waveformPeaks = null;
  loadWaveformPeaks(state.masterResult.filename);
  renderNLETimeline();
  scheduleProjectSave();
  showToast("Mastered track is now the project's audio. Switch back to Music Video / Explainer to use it.", "success");
}

// Generate AI background music and load it as the timeline's audio bed
async function generateMusic() {
  const promptText = musicPromptInput.value.trim()
    || (state.explainer && state.explainer.musicPrompt)
    || '';

  if (!promptText) {
    showToast("Describe the music first, or generate a video plan for an auto-matched prompt.", "warning");
    return;
  }

  const durationSeconds = Math.round(getNLEContentDuration());
  const replacingUpload = state.audio !== null;

  const btn = document.getElementById('btnGenerateMusic');
  btn.disabled = true;
  btn.innerText = "Composing Music...";
  if (musicStatus) {
    musicStatus.innerText = `Generating ${durationSeconds}s of background music...`;
    musicStatus.style.color = 'var(--color-text-muted)';
  }

  try {
    const res = await fetch('/api/generate-music', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText, durationSeconds: durationSeconds })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to generate music");
    }

    const data = await res.json();

    // The generated track becomes the audio bed — same path as an uploaded song
    state.audio = { filename: data.filename, duration: Math.round(data.duration * 10) / 10 };
    if (nleAudioElement) nleAudioElement.src = `/outputs/${data.filename}`;
    nleState.waveformPeaks = null;
    loadWaveformPeaks(data.filename);
    renderNLETimeline();

    // Let the user audition the track and redo it if they don't like it
    showAudition('musicAuditionBox', 'musicAuditionPlayer', data.filename);

    const engineLabel = data.engine === 'lyria-3' ? 'Lyria 3' : 'local ambient synth (fallback)';
    if (musicStatus) {
      musicStatus.innerText = `✅ Background music ready (${state.audio.duration}s, ${engineLabel}).${replacingUpload ? ' Replaced the previous audio track.' : ''} It plays in the preview and is ducked under the voiceover in the final render.`;
      musicStatus.style.color = 'var(--color-success)';
    }
    showToast(`Background music generated with ${engineLabel}!`, "success");
  } catch (error) {
    console.error(error);
    if (musicStatus) {
      musicStatus.innerText = `Music generation failed: ${error.message}`;
      musicStatus.style.color = 'var(--color-warning)';
    }
    showToast(`Music generation failed: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerText = "Generate Background Music";
  }
}

// Re-render the timeline when intro/outro cards are toggled, durations changed or titles edited
[nleIntroEnabled, nleOutroEnabled, nleIntroDuration, nleOutroDuration].forEach(el => {
  if (el) el.addEventListener('change', () => {
    pauseNLEPlayback();
    renderNLETimeline();
    scheduleProjectSave();
  });
});
[nleIntroTitle, nleIntroSubtitle, nleOutroTitle, nleOutroCTA, nleIntroDuration, nleOutroDuration].forEach(el => {
  if (el) el.addEventListener('input', () => {
    renderNLETimeline();
    scheduleProjectSave();
  });
});

// Zoom Controls
if (btnZoomIn && btnZoomOut) {
  btnZoomIn.addEventListener('click', () => {
    nleState.zoom = Math.min(5.0, nleState.zoom + 0.5);
    renderNLETimeline();
  });
  btnZoomOut.addEventListener('click', () => {
    nleState.zoom = Math.max(0.5, nleState.zoom - 0.5);
    renderNLETimeline();
  });
}

// Compile YouTube Master Video Button
if (btnNLECompileMaster) {
  btnNLECompileMaster.addEventListener('click', async () => {
    const readyScenes = state.scenes.filter(s => s.generatedUrl !== null);
    if (readyScenes.length === 0) {
      showToast("Please generate at least one Omni Flash scene first.", "warning");
      return;
    }

    btnNLECompileMaster.disabled = true;
    btnNLECompileMaster.innerHTML = `<span class="loading-spinner"></span> Rendering YouTube Video...`;

    try {
      let cardKit = state.lastSEOKit;
      if (!cardKit || !cardKit.introCardTitle || !cardKit.outroCardCTA) {
        cardKit = await generateSEOKit({ silent: true });
      }
      if (!cardKit) throw new Error('AI could not create the contextual intro/outro package');
      applyAICardPackage(cardKit);
      if (!getCardImageSrc('intro') && !(await generateCardBackground('intro'))) {
        throw new Error('AI could not create the contextual intro background');
      }
      if (!getCardImageSrc('outro') && !(await generateCardBackground('outro'))) {
        throw new Error('AI could not create the contextual outro background');
      }

      const scenesPayload = state.scenes.map(s => ({
        filename: s.filename,
        duration: s.start && s.end ? timeToSeconds(s.end) - timeToSeconds(s.start) : 10.0
      }));

      const lyricsList = getLyricsBlocks();

      const subPos = nleSubPosition ? nleSubPosition.value : 'none';
      const subtitleStyle = {
        enabled: false,
        position: subPos,
        fontSize: parseInt(nleSubFontSize ? nleSubFontSize.value : '32', 10),
        fontColor: nleSubTextColor ? nleSubTextColor.value : '#ffffff',
        strokeColor: nleSubStrokeColor ? nleSubStrokeColor.value : '#000000',
        bgBox: nleSubBgBox ? nleSubBgBox.checked : true
      };

      const introCard = {
        enabled: nleIntroEnabled ? nleIntroEnabled.checked : true,
        title: nleIntroTitle ? nleIntroTitle.value.trim() : '',
        subtitle: nleIntroSubtitle ? nleIntroSubtitle.value.trim() : '',
        ...getCardImagePayload('intro'),
        imageMode: getInputValue('introImageMode') || 'background',
        kenBurns: !!getInputValue('introKenBurns'),
        subscribe: !!getInputValue('introSubscribe'),
        hideText: !!(getCardImagePayload('intro').hideText || (document.getElementById('introHideText') && document.getElementById('introHideText').checked)),
        duration: getNLEIntroDuration()
      };

      const outroCard = {
        enabled: nleOutroEnabled ? nleOutroEnabled.checked : true,
        title: nleOutroTitle ? nleOutroTitle.value.trim() : '',
        ctaText: nleOutroCTA ? nleOutroCTA.value.trim() : '',
        ...getCardImagePayload('outro'),
        imageMode: getInputValue('outroImageMode') || 'background',
        kenBurns: !!getInputValue('outroKenBurns'),
        subscribe: document.getElementById('outroSubscribe') ? document.getElementById('outroSubscribe').checked : true,
        hideText: !!(getCardImagePayload('outro').hideText || (document.getElementById('outroHideText') && document.getElementById('outroHideText').checked)),
        duration: getNLEOutroDuration()
      };

      const res = await fetch('/api/compile-studio-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          audioFilename: state.audio ? state.audio.filename : null,
          narrationFilename: state.narrationAudio ? state.narrationAudio.filename : null,
          scenes: scenesPayload,
          lyrics: lyricsList,
          subtitleStyle: subtitleStyle,
          introCard: introCard,
          outroCard: outroCard,
          orientation: state.orientation,
          logo: await getLogoPayload(),
          polish: {
            transition: getInputValue('polishTransition') || 'cut',
            transitionDuration: parseFloat(getInputValue('polishTransitionDur')) || 0.5,
            musicFadeIn: !!getInputValue('polishMusicFadeIn'),
            fadeInDuration: parseFloat(getInputValue('polishFadeInDur')) || 2,
            audioFadeOut: !!getInputValue('polishAudioFadeOut'),
            loudnorm: !!getInputValue('polishLoudnorm'),
            videoFadeOut: !!getInputValue('polishVideoFadeOut')
          }
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to render YouTube master video");
      }

      const data = await res.json();

      finalVideo.src = data.videoUrl;
      finalVideo.muted = false;
      finalVideo.volume = 1;
      downloadLink.href = data.videoUrl;
      mergedVideoDisplay.style.display = 'block';

      pauseNLEPlayback();
      finalVideo.play().catch(() => {
        showToast('Video ready - press play in the player to hear the final mix.', 'info');
      });

      // Remember the master file for the Publish Package export
      state.lastRender = { filename: data.filename, at: Date.now() };
      updatePackageStatus();
      scheduleProjectSave();

      // Auto-organize this project's artifacts into outputs/projects/<name>/ (+ GCS)
      try {
        const projName = (projectsIndex && projectsIndex.projects[projectsIndex.currentId] && projectsIndex.projects[projectsIndex.currentId].name) || 'project';
        const files = buildProjectFileList(collectProject());
        if (files.length) {
          fetch('/api/project/organize', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: projName, files })
          }).catch(() => {});
        }
      } catch {}

      showToast("Master video rendered! Continue to Publish for SEO, thumbnails and the upload package.", "success");
      const currentProj = (projectsIndex && projectsIndex.projects[projectsIndex.currentId] && projectsIndex.projects[projectsIndex.currentId].name) || 'Project';
      sendNativeNotification('🎬 OmniStudio: Master Video Ready', `Master video for "${currentProj}" rendered successfully!`);
      mergedVideoDisplay.scrollIntoView({ behavior: 'smooth' });

    } catch (error) {
      console.error(error);
      showToast(`Local compilation failed: ${error.message}`, "error");
      sendNativeNotification('⚠️ OmniStudio: Video Render Error', `Rendering failed: ${error.message}`);
    } finally {
      btnNLECompileMaster.disabled = false;
      btnNLECompileMaster.innerHTML = `Render YouTube Video`;
    }
  });
}


/* ==========================================================================
   Project Persistence — auto-save & restore via localStorage
   ========================================================================== */

const PROJECT_STORAGE_KEY = 'omnistudio_project_v1'; // legacy single-project key (migration only)
const PROJECTS_KEY = 'omnistudio_projects_v1';
let projectsIndex = null; // { currentId, projects: { id: { name, savedAt, data } } }
let persistenceReady = false;
let projectSaveTimer = null;
let saveIndicatorTimer = null;

// Load the multi-project index, migrating the old single-project storage if present
function loadProjectsIndex() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw) {
      const idx = JSON.parse(raw);
      if (idx && idx.projects && idx.currentId && idx.projects[idx.currentId]) {
        idx.deleted = idx.deleted || {}; // tombstones: { id: deletedAt } — makes deletions propagate & stick
        return idx;
      }
    }
  } catch (err) {
    console.warn('Projects index unreadable:', err);
  }
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) || 'null'); } catch {}
  const id = 'p_' + Date.now().toString(36);
  return {
    currentId: id,
    projects: { [id]: { name: 'Project 1', savedAt: legacy ? legacy.savedAt : Date.now(), data: legacy } },
    deleted: {}
  };
}

const TOMBSTONE_TTL_MS = 45 * 24 * 3600 * 1000; // forget a deletion after 45 days

let cloudSyncEnabled = false;
let cloudPushTimer = null;

function persistProjectsIndex() {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex));
  } catch (err) {
    console.warn('Projects index save failed:', err);
  }
  pushProjectsToCloud();
}

// Merge cloud + local project libraries on startup (newer savedAt wins per project)
async function syncProjectsFromCloud() {
  try {
    const statusRes = await fetch('/api/cloud/status');
    const status = await statusRes.json();
    cloudSyncEnabled = !!status.firestore;
    if (!cloudSyncEnabled) return;

    const res = await fetch('/api/cloud/projects');
    const { index: cloudIndex } = await res.json();
    if (cloudIndex && cloudIndex.projects) {
      // 1. Union the tombstones (a deletion on either machine wins)
      const deleted = { ...(projectsIndex.deleted || {}) };
      for (const [id, ts] of Object.entries(cloudIndex.deleted || {})) {
        deleted[id] = Math.max(deleted[id] || 0, ts || 0);
      }
      // 2. Merge projects — newer savedAt wins
      const merged = { ...projectsIndex.projects };
      for (const [id, cp] of Object.entries(cloudIndex.projects)) {
        const local = merged[id];
        if (!local || (cp.savedAt || 0) > (local.savedAt || 0)) merged[id] = cp;
      }
      // 3. Apply tombstones: drop any project not edited since it was deleted
      //    (an edit newer than the deletion is a deliberate resurrection and stays)
      for (const [id, delTs] of Object.entries(deleted)) {
        if (merged[id] && (merged[id].savedAt || 0) <= delTs) delete merged[id];
      }
      // 4. Purge expired tombstones so the map stays small
      const cutoff = Date.now() - TOMBSTONE_TTL_MS;
      for (const [id, ts] of Object.entries(deleted)) if ((ts || 0) < cutoff) delete deleted[id];

      projectsIndex.projects = merged;
      projectsIndex.deleted = deleted;
      // Never end up with zero projects
      if (Object.keys(merged).length === 0) {
        const nid = 'p_' + Date.now().toString(36);
        projectsIndex.projects[nid] = { name: 'Project 1', savedAt: Date.now(), data: null };
        projectsIndex.currentId = nid;
      } else if (!merged[projectsIndex.currentId]) {
        projectsIndex.currentId = cloudIndex.currentId && merged[cloudIndex.currentId]
          ? cloudIndex.currentId
          : Object.keys(merged).sort((a, b) => (merged[b].savedAt || 0) - (merged[a].savedAt || 0))[0];
      }
      console.log('Synced project library from cloud.');
    }
  } catch (err) {
    console.warn('Cloud project sync unavailable:', err.message);
  }
}

// Debounced push of the whole project library to Firestore
function pushProjectsToCloud() {
  if (!cloudSyncEnabled) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    fetch('/api/cloud/projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: projectsIndex })
    }).catch(err => console.warn('Cloud project push failed:', err.message));
  }, 1500);
}

// Immediate, awaited push — used before a reload so deletions/tombstones can't be
// lost to the debounce timer being cancelled by the page reload.
async function flushProjectsToCloudNow() {
  if (!cloudSyncEnabled) return;
  clearTimeout(cloudPushTimer);
  try {
    await fetch('/api/cloud/projects', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: projectsIndex })
    });
  } catch (err) {
    console.warn('Cloud project flush failed:', err.message);
  }
}

// Delete any project (current or not). Tombstoned so the removal propagates to
// the other Mac and never resurrects on the next cloud sync.
async function deleteProjectById(id) {
  const entry = projectsIndex.projects[id];
  if (!entry) return;
  if (!projectsIndex.deleted) projectsIndex.deleted = {};
  projectsIndex.deleted[id] = Date.now();
  delete projectsIndex.projects[id];

  if (id === projectsIndex.currentId) {
    // Deleting the open project: pick another (or a fresh one) and reload
    persistenceReady = false;              // stop the debounced save from re-writing it
    clearTimeout(projectSaveTimer);
    const remaining = Object.keys(projectsIndex.projects)
      .sort((a, b) => (projectsIndex.projects[b].savedAt || 0) - (projectsIndex.projects[a].savedAt || 0));
    if (remaining.length === 0) {
      const nid = 'p_' + Date.now().toString(36);
      projectsIndex.projects[nid] = { name: 'Project 1', savedAt: Date.now(), data: null };
      projectsIndex.currentId = nid;
    } else {
      projectsIndex.currentId = remaining[0];
    }
    try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex)); } catch {}
    await flushProjectsToCloudNow();
    window.location.reload();
  } else {
    // Deleting a background project: no reload needed
    try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex)); } catch {}
    await flushProjectsToCloudNow();
    renderProjectSelect();
    renderProjectsManager();
  }
}

function renderProjectSelect() {
  const sel = document.getElementById('projectSelect');
  if (!sel || !projectsIndex) return;
  const entries = Object.entries(projectsIndex.projects)
    .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
  sel.innerHTML = entries
    .map(([id, p]) => `<option value="${id}" ${id === projectsIndex.currentId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
    .join('') +
    '<option disabled>──────</option>' +
    '<option value="__manage">Manage projects…</option>' +
    '<option value="__export">Export current project (.zip)…</option>' +
    '<option value="__import">Import project archive…</option>' +
    '<option value="__delete">Delete current project…</option>';
}

// Export the current project + all referenced media as one portable zip
async function exportCurrentProjectFlow() {
  flushProjectSave();
  renderProjectSelect(); // snap the dropdown back to the current project
  const entry = projectsIndex.projects[projectsIndex.currentId];
  showToast('Packing project and media files…', 'info');
  try {
    const res = await fetch('/api/project/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: collectProject(), name: entry ? entry.name : 'project' })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Export failed');
    }
    const data = await res.json();
    const a = document.createElement('a');
    a.href = data.url;
    a.download = data.filename;
    a.click();
    showToast(`Project exported with ${data.mediaCount} media file${data.mediaCount === 1 ? '' : 's'} bundled. Keep the .zip anywhere — import it later to resume exactly here.`, 'success');
  } catch (err) {
    console.error(err);
    showToast(`Export failed: ${err.message}`, 'error');
  }
}

// Import a project archive: media goes back to outputs/, project joins the library
async function importProjectFile(file) {
  renderProjectSelect();
  if (!file) return;
  const fd = new FormData();
  fd.append('project', file);
  showToast('Importing project archive…', 'info');
  try {
    const res = await fetch('/api/project/import', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Import failed');
    }
    const { project } = await res.json();

    const suggested = (project.explainer && project.explainer.videoTitle)
      || file.name.replace(/\.zip$/i, '').replace(/^omniproj_/, '').replace(/_\d+$/, '').replace(/_/g, ' ')
      || 'Imported project';
    const name = prompt('Name for the imported project:', suggested);
    if (name === null) return;

    flushProjectSave();
    const id = 'p_' + Date.now().toString(36);
    projectsIndex.projects[id] = { name: name.trim() || 'Imported project', savedAt: Date.now(), data: project };
    projectsIndex.currentId = id;
    persistenceReady = false;
    persistProjectsIndex();
    window.location.reload();
  } catch (err) {
    console.error(err);
    showToast(`Import failed: ${err.message}`, 'error');
  }
}

function flushProjectSave() {
  clearTimeout(projectSaveTimer);
  saveProject();
}

async function newProjectFlow() {
  const name = prompt('Name for the new project:', `Project ${Object.keys(projectsIndex.projects).length + 1}`);
  if (name === null) { renderProjectSelect(); return; }
  flushProjectSave();
  const id = 'p_' + Date.now().toString(36);
  projectsIndex.projects[id] = { name: name.trim() || 'Untitled Project', savedAt: Date.now(), data: null };
  projectsIndex.currentId = id;
  persistenceReady = false;
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex)); } catch {}
  await flushProjectsToCloudNow();
  window.location.reload();
}

async function switchProject(id) {
  if (!projectsIndex.projects[id] || id === projectsIndex.currentId) return;
  flushProjectSave();
  projectsIndex.currentId = id;
  persistenceReady = false;
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex)); } catch {}
  await flushProjectsToCloudNow();
  window.location.reload();
}

function deleteCurrentProjectFlow() {
  const entry = projectsIndex.projects[projectsIndex.currentId];
  if (!confirm(`Delete project "${entry ? entry.name : ''}"? This cannot be undone (rendered files stay in outputs/).`)) {
    renderProjectSelect();
    return;
  }
  deleteProjectById(projectsIndex.currentId);
}

/* ---------------- Projects Manager (see, delete, clean up orphans) ---------------- */

function openProjectsManager() {
  renderProjectSelect(); // snap dropdown back off the "__manage" sentinel
  renderProjectsManager();
  const bd = document.getElementById('pmModalBackdrop');
  if (bd) bd.style.display = 'flex';
}

function closeProjectsManager() {
  const bd = document.getElementById('pmModalBackdrop');
  if (bd) bd.style.display = 'none';
}

function projectEntryIsEmpty(p) {
  return !p || !p.data || !projectHasContent(p.data);
}

function renderProjectsManager() {
  const list = document.getElementById('pmList');
  if (!list || !projectsIndex) return;
  const entries = Object.entries(projectsIndex.projects)
    .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
  const emptyCount = entries.filter(([id, p]) => id !== projectsIndex.currentId && projectEntryIsEmpty(p)).length;

  const summary = document.getElementById('pmSummary');
  if (summary) {
    summary.textContent = `${entries.length} project(s)${emptyCount ? ` · ${emptyCount} empty (orphan)` : ''}. `
      + (cloudSyncEnabled ? 'Deletions sync to your other Mac.' : 'Stored locally on this Mac.');
  }
  const cleanBtn = document.getElementById('pmCleanEmpty');
  if (cleanBtn) { cleanBtn.disabled = emptyCount === 0; cleanBtn.textContent = `Delete ${emptyCount || ''} empty project${emptyCount === 1 ? '' : 's'}`.replace('  ', ' '); }

  list.innerHTML = entries.map(([id, p]) => {
    const isCurrent = id === projectsIndex.currentId;
    const empty = projectEntryIsEmpty(p);
    const when = p.savedAt ? new Date(p.savedAt).toLocaleString() : '—';
    return `
    <div class="pm-row ${isCurrent ? 'pm-current' : ''}" data-id="${id}">
      <div class="pm-info">
        <input class="pm-name-input" data-pm-rename="${id}" value="${escapeHtml(p.name || 'Untitled')}" title="Click to rename">
        ${isCurrent ? '<span class="pm-badge cur">current</span>' : ''}
        ${empty ? '<span class="pm-badge empty">empty</span>' : ''}
        <span class="pm-when">${when}</span>
      </div>
      <div class="pm-row-actions">
        ${isCurrent ? '' : `<button class="btn btn-secondary btn-sm" data-pm-open="${id}">Open</button>`}
        ${empty ? '' : `<button class="btn btn-secondary btn-sm" data-pm-organize="${id}" title="Gather all this project's videos/audio into outputs/projects/<name>/ and GCS">📁 Organize files</button>`}
        <button class="btn btn-secondary btn-sm" data-pm-del="${id}">Delete</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-pm-rename]').forEach(inp => inp.addEventListener('change', async () => {
    const id = inp.dataset.pmRename;
    const entry = projectsIndex.projects[id];
    const name = inp.value.trim();
    if (!entry || !name) { inp.value = entry ? entry.name : ''; return; }
    entry.name = name;
    entry.savedAt = Date.now();
    try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex)); } catch {}
    await flushProjectsToCloudNow();
    renderProjectSelect();
    showToast('Project renamed.', 'success');
  }));
  list.querySelectorAll('[data-pm-open]').forEach(b => b.addEventListener('click', () => switchProject(b.dataset.pmOpen)));
  list.querySelectorAll('[data-pm-organize]').forEach(b => b.addEventListener('click', () => organizeProjectArtifacts(b.dataset.pmOrganize)));
  list.querySelectorAll('[data-pm-del]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.pmDel;
    const p = projectsIndex.projects[id];
    if (!confirm(`Delete project "${p ? p.name : ''}"? This cannot be undone (rendered files stay in outputs/).`)) return;
    deleteProjectById(id);
  }));
}

// Every media filename a project references (server files, not inline data URLs)
function collectProjectMediaFilenames(data) {
  if (!data) return [];
  const names = new Set();
  const add = (f) => { if (typeof f === 'string' && !f.startsWith('data:') && !f.startsWith('/')) names.add(f); };
  (data.scenes || []).forEach(s => add(s.filename));
  [data.audio, data.narrationAudio, data.masterTrack, data.masterResult, data.lastRender]
    .forEach(o => { if (o && o.filename) add(o.filename); });
  (data.thumbnails || []).forEach(t => add(t.filename));
  (data.shorts || []).forEach(s => add(s.filename));
  const ci = data.cardImages || {};
  ['intro', 'outro'].forEach(k => { if (ci[k] && ci[k].filename) add(ci[k].filename); });
  return [...names];
}

// Same references, tagged with a role so the per-project folder is self-describing
// (scene_01_…, song_…, master_…, thumbnail_…).
function buildProjectFileList(data) {
  if (!data) return [];
  const out = [];
  const seen = new Set();
  const add = (f, role) => {
    if (typeof f !== 'string' || f.startsWith('data:') || f.startsWith('/') || seen.has(f)) return;
    seen.add(f); out.push({ filename: f, role });
  };
  (data.scenes || []).forEach((s, i) => add(s.filename, `scene_${String(i + 1).padStart(2, '0')}`));
  if (data.audio) add(data.audio.filename, 'audio');
  if (data.narrationAudio) add(data.narrationAudio.filename, 'voiceover');
  if (data.masterTrack) add(data.masterTrack.filename, 'mastertrack');
  if (data.masterResult) add(data.masterResult.filename, 'mastered');
  if (data.lastRender) add(data.lastRender.filename, 'master');
  (data.thumbnails || []).forEach((t, i) => add(t.filename, `thumbnail_${i + 1}`));
  (data.shorts || []).forEach((s, i) => add(s.filename, `short_${i + 1}`));
  const ci = data.cardImages || {};
  ['intro', 'outro'].forEach(k => { if (ci[k] && ci[k].filename) add(ci[k].filename, `card_${k}`); });
  return out;
}

// Gather all of a project's artifacts into outputs/projects/<name>/ (+ GCS library/projects/<name>/)
async function organizeProjectArtifacts(id) {
  const entry = projectsIndex.projects[id];
  if (!entry) return;
  const files = buildProjectFileList(entry.data);
  if (files.length === 0) { showToast('This project has no generated artifacts yet.', 'info'); return; }
  const status = document.getElementById('pmSyncStatus');
  if (status) status.textContent = `Organizing ${files.length} artifact(s) for "${entry.name}"…`;
  try {
    const res = await fetch('/api/project/organize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName: entry.name, files })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'organize failed');
    if (status) {
      status.textContent = `📁 ${d.organized.length} file(s) → ${d.localFolder}/`
        + (d.gcsPrefix ? `  ·  ☁️ ${d.gcsPrefix}` : '')
        + (d.missing.length ? `  ·  ${d.missing.length} not on this Mac` : '');
    }
    showToast(`Organized ${d.organized.length} artifact(s) into ${d.localFolder}/`, 'success');
  } catch (err) {
    if (status) status.textContent = `Organize failed: ${err.message}`;
    showToast(`Organize failed: ${err.message}`, 'error');
  }
}

// Push every referenced media file that lives on THIS Mac up to GCS, so the
// other Mac can pull them. Recovers projects whose bytes never mirrored.
async function syncAllMediaToCloud() {
  const btn = document.getElementById('pmSyncMedia');
  const status = document.getElementById('pmSyncStatus');
  const names = new Set();
  Object.values(projectsIndex.projects).forEach(p => collectProjectMediaFilenames(p.data).forEach(n => names.add(n)));
  const filenames = [...names];
  if (filenames.length === 0) { if (status) status.textContent = 'No media referenced by any project.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  if (status) status.textContent = `Uploading ${filenames.length} referenced file(s)…`;
  try {
    const res = await fetch('/api/cloud/backfill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'backfill failed');
    if (status) {
      status.textContent = `Uploaded ${d.uploaded.length} · already-elsewhere/missing on this Mac ${d.missingLocally.length}`
        + (d.missingLocally.length ? ` (those exist only on the Mac that generated them)` : '');
    }
    showToast(`Synced ${d.uploaded.length} media file(s) to the cloud.`, 'success');
  } catch (err) {
    if (status) status.textContent = `Sync failed: ${err.message}`;
    showToast(`Media sync failed: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '☁️ Sync media to cloud'; }
  }
}

async function cleanEmptyProjects() {
  const empties = Object.entries(projectsIndex.projects)
    .filter(([id, p]) => id !== projectsIndex.currentId && projectEntryIsEmpty(p))
    .map(([id]) => id);
  if (empties.length === 0) { showToast('No empty projects to delete.', 'info'); return; }
  if (!confirm(`Delete ${empties.length} empty project(s)? This cannot be undone.`)) return;
  if (!projectsIndex.deleted) projectsIndex.deleted = {};
  const now = Date.now();
  empties.forEach(id => { projectsIndex.deleted[id] = now; delete projectsIndex.projects[id]; });
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex)); } catch {}
  await flushProjectsToCloudNow();
  renderProjectSelect();
  renderProjectsManager();
  showToast(`Deleted ${empties.length} empty project(s).`, 'success');
}

function getInputValue(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  return el.type === 'checkbox' ? el.checked : el.value;
}

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (!el || value === null || value === undefined) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value;
}

const PERSISTED_INPUT_IDS = [
  'lyricsInput', 'songPromptInput',
  'explainerTopicInput', 'explainerDuration', 'explainerStyle',
  'musicMoodSelect', 'musicPromptInput', 'nleVoiceSelect',
  'nleSubPosition', 'nleSubFontSize', 'nleSubTextColor', 'nleSubStrokeColor', 'nleSubBgBox',
  'nleIntroEnabled', 'nleIntroTitle', 'nleIntroSubtitle', 'nleIntroDuration',
  'nleOutroEnabled', 'nleOutroTitle', 'nleOutroCTA', 'nleOutroDuration',
  'chkAutoRealism', 'realismThreshold',
  'introImageMode', 'introKenBurns', 'introSubscribe',
  'outroImageMode', 'outroKenBurns', 'outroSubscribe',
  'polishTransition', 'polishTransitionDur', 'polishMusicFadeIn', 'polishFadeInDur',
  'polishAudioFadeOut', 'polishLoudnorm', 'polishVideoFadeOut',
  'logoEnabled', 'logoPosition', 'logoSize', 'logoOpacity',
  'chapterText', 'shortsCount', 'shortsStyle',
  'masterStyle', 'masterTarget', 'masterWiden'
];

function collectProject() {
  const inputs = {};
  PERSISTED_INPUT_IDS.forEach(id => { inputs[id] = getInputValue(id); });
  return {
    version: 1,
    savedAt: Date.now(),
    mode: state.mode,
    step: state.step,
    audio: state.audio,
    narrationAudio: state.narrationAudio,
    timedLyrics: state.timedLyrics,
    explainer: state.explainer,
    activeCharacter: state.activeCharacter,
    cardImages: state.cardImages,
    brandRef: state.brandRef,
    channelId: state.channelId,
    youtubeChannelId: state.youtubeChannelId,
    projectLogo: state.projectLogo,
    orientation: state.orientation,
    lastSEOKit: state.lastSEOKit,
    thumbnails: state.thumbnails,
    localizations: state.localizations,
    lastRender: state.lastRender,
    shorts: state.shorts,
    lastContentMode: state.lastContentMode,
    masterTrack: state.masterTrack,
    masterResult: state.masterResult,
    scenes: state.scenes.map(s => ({ ...s, generating: false })),
    inputs: inputs
  };
}

function projectHasContent(project) {
  return !!(
    (project.scenes && project.scenes.some(s => s.prompt || s.generatedUrl)) ||
    project.audio || project.narrationAudio || project.explainer ||
    (project.inputs && (project.inputs.lyricsInput || project.inputs.explainerTopicInput))
  );
}

function saveProject() {
  if (!persistenceReady || !projectsIndex) return;
  const entry = projectsIndex.projects[projectsIndex.currentId];
  if (!entry) return;

  const project = collectProject();
  entry.data = project;
  entry.savedAt = project.savedAt;

  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex));
  } catch (err) {
    // Storage quota exceeded — retry without heavy image data
    try {
      if (project.activeCharacter && project.activeCharacter.type === 'custom') {
        project.activeCharacter = null;
      }
      project.cardImages = { intro: null, outro: null };
      project.brandRef = null;
      entry.data = project;
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex));
    } catch (err2) {
      console.warn('Project auto-save failed:', err2);
      return;
    }
  }
  flashSaveIndicator();
  scheduleOrganizeCurrentProject();
}

function scheduleProjectSave() {
  if (!persistenceReady) return;
  clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(saveProject, 800);
}

// Keep the current project's per-project folder (outputs/projects/<name>/ + GCS)
// up to date as artifacts are generated, so it's always a complete browsable set.
// Debounced long + gated on having media, so it never spams during editing.
let organizeTimer = null;
function scheduleOrganizeCurrentProject() {
  clearTimeout(organizeTimer);
  organizeTimer = setTimeout(() => {
    const entry = projectsIndex && projectsIndex.projects[projectsIndex.currentId];
    if (!entry) return;
    const files = buildProjectFileList(collectProject());
    if (!files.length) return; // nothing generated yet — no folder needed
    fetch('/api/project/organize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName: entry.name, files })
    }).catch(() => {});
  }, 7000);
}

function flashSaveIndicator() {
  const el = document.getElementById('saveIndicator');
  if (!el) return;
  el.classList.add('visible');
  clearTimeout(saveIndicatorTimer);
  saveIndicatorTimer = setTimeout(() => el.classList.remove('visible'), 1500);
}

function restoreProject() {
  const entry = projectsIndex ? projectsIndex.projects[projectsIndex.currentId] : null;
  const project = entry ? entry.data : null;
  if (!project || project.version !== 1 || !projectHasContent(project)) return false;

  // Core state
  state.mode = ['explainer', 'master'].includes(project.mode) ? project.mode : 'music';
  state.lastContentMode = project.lastContentMode === 'explainer' ? 'explainer' : 'music';
  state.masterTrack = project.masterTrack || null;
  state.masterResult = project.masterResult || null;
  state.audio = project.audio || null;
  state.narrationAudio = project.narrationAudio || null;
  state.timedLyrics = project.timedLyrics || null;
  state.explainer = project.explainer || null;
  state.scenes = (project.scenes || []).map((s, i) => ({ ...s, index: i, generating: false }));
  if (project.activeCharacter) state.activeCharacter = project.activeCharacter;
  state.cardImages = project.cardImages || { intro: null, outro: null };
  state.brandRef = project.brandRef || null;
  state.channelId = project.channelId || null;
  state.youtubeChannelId = project.youtubeChannelId || project.channelId || null;
  state.projectLogo = project.projectLogo || null;
  updateCardImageUI('intro', 'introImageThumb', 'btnIntroImageRemove');
  updateCardImageUI('outro', 'outroImageThumb', 'btnOutroImageRemove');
  updateBrandUI();
  setOrientation(project.orientation || 'landscape');
  state.lastSEOKit = project.lastSEOKit || null;
  state.thumbnails = project.thumbnails || [];
  state.localizations = project.localizations || [];
  state.lastRender = project.lastRender || null;
  state.shorts = project.shorts || [];

  // Form inputs. Old static card copy is removed once and never restored again.
  const cardMigration = migratePersistedCardCopy(project.inputs || {}, state.lastSEOKit);
  project.inputs = cardMigration.inputs;
  Object.entries(project.inputs).forEach(([id, value]) => setInputValue(id, value));
  if (cardMigration.changed) {
    entry.data = project;
    entry.savedAt = Date.now();
    persistProjectsIndex();
  }

  // Project type UI (music / explainer / master)
  applyProjectTypeUI();
  renderMasterUI();
  updateLogoUI();

  // Character UI
  if (state.activeCharacter && state.activeCharacter.type === 'custom' && state.activeCharacter.data) {
    document.querySelectorAll('.character-card').forEach(c => c.classList.remove('active'));
    uploadPreview.src = state.activeCharacter.data;
    uploadPreviewContainer.style.display = 'flex';
    dropZone.style.display = 'none';
    if (state.activeCharacter.views && state.activeCharacter.views.length > 0) {
      const viewsSection = document.getElementById('characterViewsSection');
      const viewsGallery = document.getElementById('characterViewsGallery');
      viewsGallery.innerHTML = '';
      const labels = ['Front', 'Side', 'Back'];
      state.activeCharacter.views.forEach((view, idx) => {
        const item = document.createElement('div');
        item.className = 'character-view-item';
        item.innerHTML = `<img src="${view}" alt="${labels[idx]} view"><span class="character-view-label">${labels[idx]}</span>`;
        viewsGallery.appendChild(item);
      });
      viewsSection.style.display = 'block';
    }
  } else if (state.activeCharacter && state.presets) {
    const preset = state.presets.characters.find(c => c.name === state.activeCharacter.name);
    if (preset) {
      document.querySelectorAll('.character-card').forEach(c => {
        c.classList.toggle('active', c.dataset.id === preset.id);
      });
    }
  }

  // Audio track UI + synced preview elements
  if (state.audio) {
    const isGenerated = state.audio.filename.startsWith('song_') || state.audio.filename.startsWith('music_');
    audioFilenameText.innerText = isGenerated ? 'AI Track (Lyria 3)' : state.audio.filename;
    audioDurationText.innerText = `Duration: ${state.audio.duration}s`;
    audioPreviewContainer.style.display = 'flex';
    audioDropZone.style.display = 'none';

    const dlMain = document.getElementById('btnDownloadAudio');
    if (dlMain) {
      dlMain.href = `/outputs/${state.audio.filename}`;
      dlMain.download = state.audio.filename;
    }

    if (nleAudioElement) nleAudioElement.src = `/outputs/${state.audio.filename}`;
    loadWaveformPeaks(state.audio.filename);
  }
  if (state.narrationAudio && nleNarrationElement) {
    nleNarrationElement.src = `/outputs/${state.narrationAudio.filename}`;
  }

  renderStoryboard();
  updateVoiceoverStatus();
  checkCompileEligibility();
  renderNLETimeline();
  goToStep(project.step >= 1 && project.step <= 4 ? project.step : 1);

  const minsAgo = Math.round((Date.now() - (project.savedAt || Date.now())) / 60000);
  showToast(`Project restored from your last session${minsAgo > 0 ? ` (${minsAgo} min ago)` : ''}.`, 'success');
  return true;
}

function initProjectPersistence() {
  persistenceReady = true;

  // Any form interaction anywhere schedules a debounced save
  document.addEventListener('input', scheduleProjectSave, true);
  document.addEventListener('change', scheduleProjectSave, true);

  // Flush any pending save when leaving the page
  window.addEventListener('beforeunload', () => {
    clearTimeout(projectSaveTimer);
    saveProject();
  });

  const btnNewProject = document.getElementById('btnNewProject');
  if (btnNewProject) btnNewProject.addEventListener('click', () => setLandingVisible(true));

  const projectSelect = document.getElementById('projectSelect');
  if (projectSelect) {
    projectSelect.addEventListener('change', () => {
      const val = projectSelect.value;
      if (val === '__manage') openProjectsManager();
      else if (val === '__delete') deleteCurrentProjectFlow();
      else if (val === '__export') exportCurrentProjectFlow();
      else if (val === '__import') {
        renderProjectSelect();
        const inp = document.getElementById('projectImportInput');
        if (inp) inp.click();
      }
      else switchProject(val);
    });
  }

  // Projects Manager modal
  const pmClose = document.getElementById('pmClose');
  if (pmClose) pmClose.addEventListener('click', closeProjectsManager);
  const pmCleanEmpty = document.getElementById('pmCleanEmpty');
  if (pmCleanEmpty) pmCleanEmpty.addEventListener('click', cleanEmptyProjects);
  const pmSyncMedia = document.getElementById('pmSyncMedia');
  if (pmSyncMedia) pmSyncMedia.addEventListener('click', syncAllMediaToCloud);
  const pmBackdrop = document.getElementById('pmModalBackdrop');
  if (pmBackdrop) pmBackdrop.addEventListener('click', (e) => { if (e.target === pmBackdrop) closeProjectsManager(); });

  const projectImportInput = document.getElementById('projectImportInput');
  if (projectImportInput) {
    projectImportInput.addEventListener('change', () => {
      const file = projectImportInput.files && projectImportInput.files[0];
      projectImportInput.value = '';
      importProjectFile(file);
    });
  }
}

/* ==========================================================================
   Content Planner — multi-channel video tracking + viral topics agent
   ========================================================================== */

const plannerState = {
  channels: [],
  videos: [],
  loaded: false,
  visible: false
};

const PLANNER_STATUSES = ['idea', 'planned', 'generating', 'ready', 'published'];
const PLANNER_FORMAT_LABELS = { long: 'YT Long', short: 'YT Short', reel: 'IG Reel' };
const PLANNER_PAGE_SIZE = 10;
let plannerPage = 1;

function plannerId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let plannerSaveTimer = null;
function savePlanner() {
  channelListCache = null; // channel edits invalidate the studio's cached list
  clearTimeout(plannerSaveTimer);
  plannerSaveTimer = setTimeout(async () => {
    try {
      await fetch('/api/planner', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: plannerState.channels, videos: plannerState.videos })
      });
      flashSaveIndicator();
    } catch (err) {
      console.error('Planner save failed:', err);
      showToast('Could not save planner changes.', 'error');
    }
  }, 500);
}

async function ensurePlannerLoaded() {
  if (plannerState.loaded) {
    renderPlanner();
    return;
  }
  try {
    const res = await fetch('/api/planner');
    const data = await res.json();
    plannerState.channels = data.channels || [];
    plannerState.videos = data.videos || [];
    plannerState.loaded = true;
    renderPlanner();
  } catch (err) {
    console.error('Planner load failed:', err);
    showToast('Could not load planner data.', 'error');
  }
}

let plannerOrigin = 'studio'; // where to return when the planner closes: 'studio' | 'landing'

function setPlannerVisible(visible) {
  const landing = document.getElementById('landingView');
  if (visible) {
    // Remember whether we opened the planner from the Home hub or the Studio
    plannerOrigin = (landing && landing.style.display === 'block') ? 'landing' : 'studio';
  }
  plannerState.visible = visible;
  const plannerView = document.getElementById('plannerView');
  const stepperNav = document.getElementById('stepperNav');
  const typeSwitch = document.querySelector('.type-switch');
  if (landing) landing.style.display = 'none'; // planner and landing must never coexist
  if (plannerView) plannerView.style.display = visible ? 'block' : 'none';

  // Closing the planner returns you to wherever you came from
  if (!visible && plannerOrigin === 'landing') {
    plannerState.visible = false;
    stopAutopilotPolling();
    const toggleBtn = document.getElementById('btnTogglePlanner');
    if (toggleBtn) toggleBtn.innerText = 'Planner';
    setLandingVisible(true);
    return;
  }
  if (stepperNav) stepperNav.style.display = (visible || state.mode === 'master') ? 'none' : 'flex';
  if (typeSwitch) typeSwitch.style.visibility = visible ? 'hidden' : 'visible';
  const masterSection = document.getElementById('masterSection');
  if (masterSection) masterSection.style.display = (!visible && state.mode === 'master') ? 'block' : 'none';
  stepPanels.forEach((panel, idx) => {
    if (panel) panel.classList.toggle('active', !visible && state.mode !== 'master' && idx + 1 === state.step);
  });
  const toggleBtn = document.getElementById('btnTogglePlanner');
  if (toggleBtn) toggleBtn.innerText = visible ? (plannerOrigin === 'landing' ? 'Back to Home' : 'Back to Studio') : 'Planner';
  if (visible) {
    pauseNLEPlayback();
    ensurePlannerLoaded();
    loadTrendWatchStatus();
    startAutopilotPolling();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    stopAutopilotPolling();
  }
}

/* ---------------- Landing / Home hub ---------------- */

const MODE_LABELS = { music: 'Music Video', explainer: 'AI Explainer', master: 'Music Master' };
const MODE_EMOJI = { music: '🎵', explainer: '🎬', master: '🎚️' };

// Build a clear default name: "KidsTunes TV · Music Video · Jul 21"
function meaningfulProjectName(mode, channelId) {
  let channelName = '';
  const ch = (plannerState.channels || []).find(c => c.id === channelId)
    || (channelListCache || []).find(c => c.id === channelId);
  if (ch) channelName = ch.name;
  const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${channelName ? channelName + ' · ' : ''}${MODE_LABELS[mode] || 'Project'} · ${date}`;
}

// True if a project entry has never been worked on (safe to reuse instead of stacking empties)
function entryIsPristine(entry) {
  return !entry || !entry.data || !projectHasContent(entry.data);
}

function setLandingVisible(visible) {
  const landing = document.getElementById('landingView');
  const stepperNav = document.getElementById('stepperNav');
  const typeSwitch = document.querySelector('.type-switch');
  if (landing) landing.style.display = visible ? 'block' : 'none';
  if (visible) {
    // Hide the planner directly (don't route back through setPlannerVisible's
    // return logic, which would bounce us here again)
    if (plannerState.visible) {
      plannerState.visible = false;
      const pv = document.getElementById('plannerView');
      if (pv) pv.style.display = 'none';
      stopAutopilotPolling();
      const tb = document.getElementById('btnTogglePlanner');
      if (tb) tb.innerText = 'Planner';
    }
    if (stepperNav) stepperNav.style.display = 'none';
    if (typeSwitch) typeSwitch.style.visibility = 'hidden';
    stepPanels.forEach(p => p && p.classList.remove('active'));
    const masterSection = document.getElementById('masterSection');
    if (masterSection) masterSection.style.display = 'none';
    pauseNLEPlayback();
    renderLanding();
    window.scrollTo({ top: 0 });
  } else {
    if (typeSwitch) typeSwitch.style.visibility = 'visible';
    if (stepperNav) stepperNav.style.display = state.mode === 'master' ? 'none' : 'flex';
  }
}

async function renderLanding() {
  // Channel picker (defaults to the current project's channel)
  const sel = document.getElementById('landingChannel');
  if (sel) {
    let channels = [];
    try { channels = await getChannelList(); } catch {}
    sel.innerHTML = '<option value="">No channel</option>' +
      channels.map(c => `<option value="${c.id}" ${c.id === state.channelId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  }
  // Recent projects (non-empty, newest first)
  const grid = document.getElementById('landingRecentGrid');
  if (grid) {
    const recents = Object.entries(projectsIndex.projects)
      .filter(([, p]) => !entryIsPristine(p))
      .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0))
      .slice(0, 12);
    grid.innerHTML = recents.length ? recents.map(([id, p]) => {
      const m = (p.data && p.data.mode) || 'music';
      const scenes = (p.data && p.data.scenes || []).filter(s => s.generatedUrl).length;
      const when = p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '';
      return `
      <button class="landing-recent-card" data-resume="${id}">
        <span class="lrc-emoji">${MODE_EMOJI[m] || '🎬'}</span>
        <span class="lrc-name">${escapeHtml(p.name || 'Untitled')}</span>
        <span class="lrc-meta">${MODE_LABELS[m] || ''}${scenes ? ` · ${scenes} scene${scenes === 1 ? '' : 's'}` : ''} · ${when}</span>
      </button>`;
    }).join('') : '<p class="section-desc">No projects yet — pick a format above to start your first one.</p>';
    grid.querySelectorAll('[data-resume]').forEach(b => b.addEventListener('click', () => switchProject(b.dataset.resume)));
  }
}

// Start a new project of the given mode from the landing hub
async function startFromLanding(mode) {
  const channelId = (document.getElementById('landingChannel') || {}).value || null;
  const name = meaningfulProjectName(mode, channelId);

  const currentEntry = projectsIndex.projects[projectsIndex.currentId];
  // Reuse the current pristine project instead of stacking another empty one
  if (!entryIsPristine(currentEntry)) {
    flushProjectSave();
    const id = 'p_' + Date.now().toString(36);
    projectsIndex.projects[id] = { name, savedAt: Date.now(), data: null };
    projectsIndex.currentId = id;
    persistenceReady = false;
    try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex)); } catch {}
    await flushProjectsToCloudNow();
    // reload so a clean project state initializes, then auto-enter the chosen mode
    sessionStorage.setItem('omni_pending_mode', JSON.stringify({ mode, channelId }));
    window.location.reload();
    return;
  }

  // Current project is pristine — rename & configure it in place (no reload needed)
  currentEntry.name = name;
  state.channelId = channelId;
  populateProjectChannelSelect();
  setLandingVisible(false);
  if (state.mode !== mode) setProjectType(mode);
  else goToStep(1);
  renderProjectSelect();
  scheduleProjectSave();
  showToast(`New ${MODE_LABELS[mode]} project: "${name}"`, 'success');
}

/* ---------------- Autopilot (hands-free production queue) ---------------- */

let apModalVideoId = null;
let apPollTimer = null;

function updateAutopilotDrainControls(draining, outstanding) {
  const drainButton = document.getElementById('btnFaDrain');
  const scanButton = document.getElementById('btnFaScanNow');
  const status = document.getElementById('faDrainStatus');
  const remaining = Number.isFinite(outstanding) ? outstanding : 0;
  if (drainButton) {
    drainButton.dataset.draining = String(draining);
    drainButton.textContent = draining ? 'Resume continuous generation' : 'Stop after outstanding jobs';
    drainButton.classList.toggle('btn-danger', !draining);
    drainButton.classList.toggle('btn-primary', draining);
  }
  if (scanButton) scanButton.disabled = draining;
  if (status) {
    status.classList.toggle('is-draining', draining);
    status.textContent = draining
      ? `Stopping automatically: ${remaining} outstanding job${remaining === 1 ? '' : 's'} will finish, then no new jobs will be generated.`
      : 'Continuous generation is active for enabled channels.';
  }
}

function openAutopilotModal(videoId) {
  const v = plannerState.videos.find(x => x.id === videoId);
  if (!v) return;
  apModalVideoId = videoId;
  const backdrop = document.getElementById('apModalBackdrop');
  const ideaEl = document.getElementById('apModalIdea');
  const ch = plannerState.channels.find(c => c.id === v.channelId);
  if (ideaEl) ideaEl.innerText = `"${v.title}"${ch ? ` → ${ch.name}` : ''}${v.hook ? ` — ${v.hook}` : ''}`;

  // Music channels: song pipeline — pick the star character; length/voice/music
  // controls don't apply (Lyria sings and decides the natural length)
  const isMusic = channelIsMusic(ch);
  const charGroup = document.getElementById('apCharacterGroup');
  const charSel = document.getElementById('apCharacter');
  if (charGroup && charSel) {
    if (isMusic) {
      const presets = (state.presets && state.presets.characters) || [];
      charSel.innerHTML = presets.map((p, i) =>
        `<option value="${p.id}" ${i === 0 ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('') ||
        '<option value="">Default</option>';
    }
    charGroup.style.display = isMusic ? 'block' : 'none';
  }
  const durGroup = document.getElementById('apDuration') && document.getElementById('apDuration').closest('.form-group');
  if (durGroup) durGroup.style.display = isMusic ? 'none' : 'block';
  const voiceGroup = document.getElementById('apVoiceGroup');
  if (voiceGroup) voiceGroup.style.display = isMusic ? 'none' : 'block';
  const musicChk = document.getElementById('apMusic') && document.getElementById('apMusic').closest('.chk-label');
  if (musicChk) musicChk.style.display = isMusic ? 'none' : 'flex';
  const pipeNote = document.getElementById('apPipelineNote');
  if (pipeNote) pipeNote.style.display = isMusic ? 'block' : 'none';

  // Default slot: tomorrow at 16:00 local (strong general-audience time)
  const slot = new Date();
  slot.setDate(slot.getDate() + 1);
  slot.setHours(16, 0, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  const el = document.getElementById('apPublishAt');
  if (el) el.value = `${slot.getFullYear()}-${pad(slot.getMonth() + 1)}-${pad(slot.getDate())}T${pad(slot.getHours())}:${pad(slot.getMinutes())}`;
  if (backdrop) backdrop.style.display = 'flex';
}

function closeAutopilotModal() {
  apModalVideoId = null;
  const backdrop = document.getElementById('apModalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

async function launchAutopilotJob() {
  const v = plannerState.videos.find(x => x.id === apModalVideoId);
  if (!v) { closeAutopilotModal(); return; }
  const publishAtRaw = document.getElementById('apPublishAt').value;
  const wantUpload = !!document.getElementById('apUpload').checked;
  let publishAt = null;
  if (wantUpload && publishAtRaw) {
    const when = new Date(publishAtRaw);
    if (isNaN(when.getTime()) || when.getTime() < Date.now() + 60000) {
      showToast('Pick a publish time in the future.', 'warning');
      return;
    }
    publishAt = when.toISOString();
  }
  try {
    const res = await fetch('/api/autopilot/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: v.channelId,
        plannerVideoId: v.id,
        title: v.title,
        topic: v.topic || v.title,
        brief: {
          angle: v.angle || '',
          hook: v.hook || '',
          keyPoints: (v.keyPoints || []).filter(Boolean),
          targetAudience: v.targetAudience || ''
        },
        options: {
          durationSeconds: parseInt(document.getElementById('apDuration').value, 10) || 60,
          orientation: document.getElementById('apOrientation').value,
          voice: document.getElementById('apVoice').value,
          character: document.getElementById('apCharacter') ? document.getElementById('apCharacter').value || null : null,
          withMusic: !!document.getElementById('apMusic').checked,
          burnSubtitles: !!(document.getElementById('apBurnSubtitles') && document.getElementById('apBurnSubtitles').checked),
          realismCheck: !!document.getElementById('apRealism').checked,
          uploadToYouTube: wantUpload,
          publishAt
        }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'enqueue failed');
    closeAutopilotModal();
    showToast(`Autopilot queued: "${v.title}"${publishAt ? ` — goes public ${new Date(publishAt).toLocaleString()}` : ''}.`, 'success');
    renderAutopilotQueue();
  } catch (err) {
    showToast(`Autopilot enqueue failed: ${err.message}`, 'error');
  }
}

const AP_STATUS_LABELS = {
  queued: { label: 'Queued', cls: 'ap-queued' },
  running: { label: 'Running', cls: 'ap-running' },
  done: { label: 'Scheduled ✓', cls: 'ap-done' },
  ready: { label: 'Assets ready', cls: 'ap-ready' },
  failed: { label: 'Failed', cls: 'ap-failed' },
  cancelled: { label: 'Cancelled', cls: 'ap-cancelled' }
};

// The ordered pipeline stages per job type (mirrors the server's PIPELINES)
const AP_PIPELINE_STEPS = {
  explainer: [['script','Script'],['music','Music'],['narration','Voiceover'],['scenes','Scenes'],['realism','Realism'],['render','Render'],['seo','SEO'],['thumbnail','Thumbnail'],['upload','Upload']],
  music:     [['song','Song'],['lyrics','Lyrics'],['storyboard','Storyboard'],['scenes','Scenes'],['realism','Realism'],['render','Render'],['seo','SEO'],['thumbnail','Thumbnail'],['upload','Upload']]
};

const apExpanded = new Set(); // job ids whose full log is open (kept across the 5s auto-refresh)

// Visual stepper: shows every stage and exactly which one is done / running / failed / pending
function renderApStepper(j) {
  const steps = AP_PIPELINE_STEPS[j.pipeline] || AP_PIPELINE_STEPS.explainer;
  const curIdx = steps.findIndex(s => s[0] === j.step);
  const finished = ['done', 'ready'].includes(j.status);
  return `<div class="ap-stepper">` + steps.map((s, i) => {
    let cls = 'pending', icon = '○';
    if (finished) { cls = 'done'; icon = '✓'; }
    else if (i < curIdx && curIdx !== -1) { cls = 'done'; icon = '✓'; }
    else if (i === curIdx) {
      if (j.status === 'failed') { cls = 'failed'; icon = '✗'; }
      else if (j.status === 'cancelled') { cls = 'cancelled'; icon = '⊘'; }
      else if (j.status === 'running') { cls = 'running'; icon = '▶'; }
    }
    return `<span class="ap-stp ap-stp-${cls}" title="${s[1]}${i === curIdx && j.status === 'failed' ? ' — failed here' : ''}"><span class="ap-stp-ico">${icon}</span><span class="ap-stp-lbl">${s[1]}</span></span>`;
  }).join('') + `</div>`;
}

// Convert an autopilot job into an editable project so you can open it in the
// Studio, inspect each stage (scenes, song, render), and regenerate/re-render manually.
function buildProjectFromJob(job) {
  const a = job.artifacts || {};
  const isMusic = job.pipeline === 'music';
  const opts = job.options || {};
  const url = f => (f ? '/outputs/' + f : null);

  const scenes = (a.scenes || []).map((s, i) => ({
    index: i,
    start: s.start || null,
    end: s.end || null,
    prompt: s.prompt || '',
    narration: s.narration || undefined,
    newBackground: !!s.newBackground,
    generatedUrl: url(s.filename),
    filename: s.filename || null,
    interactionId: null,
    generating: false,
    ...(s.realismScore != null ? { realismScore: s.realismScore } : {})
  }));

  let activeCharacter = null;
  if (isMusic && a.characterName && state.presets) {
    const preset = (state.presets.characters || []).find(c => c.name === a.characterName);
    if (preset) activeCharacter = { type: 'preset', name: preset.name, fileUrl: preset.file };
  }

  return {
    version: 1,
    mode: isMusic ? 'music' : 'explainer',
    step: 2, // land on the storyboard so the scene stages are right there
    audio: isMusic
      ? (a.songFilename ? { filename: a.songFilename, duration: a.songDuration || 60 } : null)
      : (a.musicFilename ? { filename: a.musicFilename, duration: opts.durationSeconds || 60 } : null),
    narrationAudio: !isMusic && a.narrationFilename ? { filename: a.narrationFilename, duration: opts.durationSeconds || 60 } : null,
    timedLyrics: isMusic ? (a.timedLyrics || null) : null,
    explainer: !isMusic ? { topic: job.topic, videoTitle: a.videoTitle || job.title, durationSeconds: opts.durationSeconds || 60 } : null,
    activeCharacter,
    cardImages: { intro: null, outro: null },
    channelId: job.channelId || null,
    lastSEOKit: a.seo || null,
    thumbnails: a.thumbnailFilename ? [{ filename: a.thumbnailFilename, url: url(a.thumbnailFilename) }] : [],
    shorts: [],
    lastRender: a.renderFilename ? { filename: a.renderFilename, at: Date.now() } : null,
    scenes,
    inputs: {
      songPromptInput: isMusic ? (job.topic || '') : '',
      explainerTopicInput: !isMusic ? (job.topic || '') : '',
      lyricsInput: isMusic && a.timedLyrics ? a.timedLyrics.map(l => l.text).join('\n') : '',
      nleIntroTitle: a.videoTitle || job.title || '',
      chapterText: a.chapters || '',
      nleVoiceSelect: opts.voice || 'Kore'
    }
  };
}

async function openAutopilotJobAsProject(jobId) {
  let job;
  try {
    const payload = await (await fetch('/api/autopilot')).json();
    job = (payload.jobs || []).find(j => j.id === jobId);
  } catch {}
  if (!job) { showToast('Could not load that job.', 'error'); return; }
  if (!job.artifacts || !(job.artifacts.scenes || []).length) {
    showToast('This job has not produced scenes yet — nothing to open.', 'warning');
    return;
  }
  flushProjectSave();
  const id = 'p_apj_' + Date.now().toString(36);
  projectsIndex.projects[id] = { name: `${job.title} (Autopilot)`.slice(0, 120), savedAt: Date.now(), data: buildProjectFromJob(job) };
  projectsIndex.currentId = id;
  persistenceReady = false;
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectsIndex)); } catch {}
  await flushProjectsToCloudNow();
  window.location.reload(); // restoreProject opens it in the Studio at the storyboard
}

async function renderAutopilotQueue() {
  const holder = document.getElementById('autopilotQueue');
  if (!holder) return;
  let payload;
  try {
    payload = await (await fetch('/api/autopilot')).json();
  } catch {
    return;
  }
  const jobsList = payload.jobs || [];
  const outstanding = jobsList.filter(job => ['queued', 'running'].includes(job.status)).length;
  updateAutopilotDrainControls(payload.draining === true, outstanding);
  if (jobsList.length === 0) {
    holder.innerHTML = '<p class="section-desc">No Autopilot jobs yet.</p>';
    return;
  }
  holder.innerHTML = jobsList.map(j => {
    const st = AP_STATUS_LABELS[j.status] || AP_STATUS_LABELS.queued;
    const lastLog = j.log && j.log.length ? j.log[j.log.length - 1].msg : '';
    const pct = j.progress && j.progress.total ? Math.round((j.progress.index / j.progress.total) * 100) : 0;
    const yt = j.artifacts && j.artifacts.youtube;
    const render = j.artifacts && j.artifacts.renderFilename;
    const generatedScenes = ((j.artifacts && j.artifacts.scenes) || []).filter(s => s.filename);
    const latestScene = generatedScenes.length ? generatedScenes[generatedScenes.length - 1].filename : null;
    const hasArtifacts = !!(render || latestScene || (j.artifacts && Object.keys(j.artifacts).length));
    const expanded = apExpanded.has(j.id);
    const fullLog = (j.log || []).map(l => `${new Date(l.t).toLocaleTimeString()}  ${l.msg}`).join('\n');
    return `
    <div class="ap-job">
      <div class="ap-job-head">
        <span class="ap-chip ${st.cls}">${st.label}</span>
        <span title="${j.pipeline === 'music' ? 'Music pipeline: song → lyrics → character scenes' : 'Explainer pipeline: script → narration → scenes'}">${j.pipeline === 'music' ? '🎵' : '🎬'}</span>
        <strong>${escapeHtml(j.title)}</strong>
        ${j.channelName ? `<span class="muted">· ${escapeHtml(j.channelName)}</span>` : ''}
        ${j.options && j.options.publishAt ? `<span class="ap-when" title="Goes public">📅 ${new Date(j.options.publishAt).toLocaleString()}</span>` : ''}
      </div>
      ${renderApStepper(j)}
      ${j.status === 'running' ? `
        <div class="ap-progress"><div class="ap-progress-fill" style="width: ${pct}%;"></div></div>
        <div class="ap-step">Step ${j.progress.index}/${j.progress.total}: ${escapeHtml(j.step || '…')} — ${escapeHtml(lastLog)}</div>` : ''}
  ${j.status === 'failed' ? `<div class="ap-step ap-error">⚠ Stuck at <strong>${escapeHtml(j.step || '?')}</strong>: ${escapeHtml(j.error || lastLog)}</div>` : ''}
      ${hasArtifacts && ['failed', 'cancelled'].includes(j.status) ? `<div class="ap-step">Saved progress: ${generatedScenes.length} generated clip${generatedScenes.length === 1 ? '' : 's'}${j.step ? ` · interrupted at ${escapeHtml(j.step)}` : ''}</div>` : ''}
      ${(j.status === 'done' || j.status === 'ready') && lastLog ? `<div class="ap-step">${escapeHtml(lastLog)}</div>` : ''}
      <div class="ap-job-actions">
        ${(j.artifacts && (j.artifacts.scenes || []).length) ? `<button class="btn btn-secondary btn-sm" data-ap-open="${j.id}" title="Open this job's scenes, song & render as an editable project to inspect stages and fix manually">📂 Open in Studio</button>` : ''}
        ${yt ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(yt.url)}" target="_blank" rel="noopener">Open on YouTube ↗</a>` : ''}
        ${render ? `<a class="btn btn-secondary btn-sm" href="/outputs/${escapeHtml(render)}" target="_blank" rel="noopener">Watch render</a>` : ''}
        ${!render && latestScene ? `<a class="btn btn-secondary btn-sm" href="/outputs/${escapeHtml(latestScene)}" target="_blank" rel="noopener">Open latest clip</a>` : ''}
        ${['queued', 'running'].includes(j.status) ? `<button class="btn btn-secondary btn-sm" data-ap-cancel="${j.id}">Cancel</button>` : ''}
        ${['failed', 'cancelled'].includes(j.status) ? `<button class="btn btn-secondary btn-sm" data-ap-retry="${j.id}">${hasArtifacts ? 'Resume' : 'Retry'}</button>` : ''}
        ${hasArtifacts && ['failed', 'cancelled'].includes(j.status) ? `<button class="btn btn-secondary btn-sm" data-ap-restart="${j.id}" title="Discard saved progress and regenerate everything">Start over</button>` : ''}
        <button class="btn btn-secondary btn-sm" data-ap-detail="${j.id}">${expanded ? 'Hide log ▾' : 'Log ▸'}</button>
        ${['done', 'ready', 'failed', 'cancelled'].includes(j.status) ? `<button class="btn btn-secondary btn-sm" data-ap-remove="${j.id}" title="Remove from the list">✕</button>` : ''}
      </div>
      ${expanded ? `<pre class="ap-log">${escapeHtml(fullLog || 'No log yet.')}</pre>` : ''}
    </div>`;
  }).join('');

  holder.querySelectorAll('[data-ap-detail]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.apDetail;
    if (apExpanded.has(id)) apExpanded.delete(id); else apExpanded.add(id);
    renderAutopilotQueue();
  }));
  holder.querySelectorAll('[data-ap-open]').forEach(b => b.addEventListener('click', () => openAutopilotJobAsProject(b.dataset.apOpen)));
  holder.querySelectorAll('[data-ap-cancel]').forEach(b => b.addEventListener('click', async () => {
    await fetch('/api/autopilot/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.apCancel }) });
    renderAutopilotQueue();
  }));
  holder.querySelectorAll('[data-ap-retry]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Restarting…';
    await fetch('/api/autopilot/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.apRetry }) });
    showToast('Job re-queued — it will run from the first step.', 'success');
    renderAutopilotQueue();
  }));
  holder.querySelectorAll('[data-ap-restart]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Discard all saved Autopilot progress for this job and regenerate it from scratch?')) return;
    await fetch('/api/autopilot/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.apRestart, fromScratch: true }) });
    renderAutopilotQueue();
  }));
  holder.querySelectorAll('[data-ap-remove]').forEach(b => b.addEventListener('click', async () => {
    await fetch('/api/autopilot/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.apRemove }) });
    renderAutopilotQueue();
  }));
}

// Per-channel Full Autopilot switches (channel.autopilot persisted with the planner)
function renderFullAutopilotConfig() {
  const holder = document.getElementById('fullAutopilotChannels');
  if (!holder) return;
  if (!plannerState.channels.length) {
    holder.innerHTML = '<p class="section-desc">Add a channel first.</p>';
    return;
  }
  const presetChars = (state.presets && state.presets.characters) || [];
  holder.innerHTML = plannerState.channels.map(ch => {
    const cfg = ch.autopilot || {};
    const opts = cfg.options || {};
    const isMusic = channelIsMusic(ch);
    return `
    <div class="fa-row" data-ch="${ch.id}">
      <label class="chk-label" style="margin: 0;">
        <input type="checkbox" class="fa-enabled" ${cfg.enabled ? 'checked' : ''}>
        <span>${isMusic ? '🎵' : '🎬'} <strong>${escapeHtml(ch.name)}</strong></span>
      </label>
      <span class="ap-chip ap-ready" title="Keeps producing until this channel is switched off">Continuous</span>
      <select class="select-input fa-hour" title="Publish time">
        ${[9, 12, 16, 18, 20].map(h => `<option value="${h}" ${(cfg.publishHour || 16) === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}
      </select>
      ${isMusic && presetChars.length ? `
      <select class="select-input fa-character" title="Star character for the songs">
        ${presetChars.map(p => `<option value="${p.id}" ${opts.character === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
      </select>` : ''}
      <label class="chk-label" style="margin: 0;" title="Upload & schedule on YouTube (otherwise: produce assets only)">
        <input type="checkbox" class="fa-upload" ${opts.uploadToYouTube !== false ? 'checked' : ''}>
        <span>Upload</span>
      </label>
    </div>`;
  }).join('');

  holder.querySelectorAll('.fa-row').forEach(row => {
    row.querySelectorAll('input, select').forEach(el => {
      el.addEventListener('change', async () => {
        const ch = plannerState.channels.find(c => c.id === row.dataset.ch);
        if (!ch) return;
        const charSel = row.querySelector('.fa-character');
        const enabled = row.querySelector('.fa-enabled').checked;
        ch.autopilot = {
          enabled,
          publishHour: parseInt(row.querySelector('.fa-hour').value, 10),
          options: {
            ...(ch.autopilot && ch.autopilot.options ? ch.autopilot.options : {}),
            uploadToYouTube: row.querySelector('.fa-upload').checked,
            ...(charSel ? { character: charSel.value } : {})
          }
        };
        savePlanner();
        if (!el.classList.contains('fa-enabled')) return;
        if (enabled) {
          showToast(`Full Autopilot ON for "${ch.name}" — it will keep producing until you switch it off.`, 'success');
          setTimeout(() => fetch('/api/autopilot/auto-run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId: ch.id })
          }).then(() => renderAutopilotQueue()), 700);
        } else {
          const response = await fetch('/api/autopilot/stop-channel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId: ch.id })
          });
          const result = await response.json();
          showToast(`Full Autopilot OFF for "${ch.name}"${result.cancelled ? ` — stopped ${result.cancelled} pending job(s)` : ''}.`, 'success');
          renderAutopilotQueue();
        }
      });
    });
  });
}

/* ---------------- Channel Manager (names, niches, brand kits, logos) ---------------- */

let cmFileTarget = null; // { channelId, kind: 'brand' | 'logo' } for the shared file input

// Visual styles Autopilot can apply per channel (values match the Studio's dropdown)
const VISUAL_STYLES = [
  ['', 'Auto (default)'],
  ['modern 3D animated explainer style, colorful, clean infographic aesthetics', '3D Animated Explainer'],
  ['minimalist flat 2D motion-graphics style, bold shapes, pastel palette', 'Flat Motion Graphics'],
  ['3D claymation style, playful, handcrafted look', 'Claymation'],
  ['cinematic photorealistic style, dramatic lighting', 'Cinematic Realistic'],
  ['retro pixel-art animation style, vibrant 16-bit colors', 'Pixel Art']
];
function visualStyleOptions(selected) {
  return VISUAL_STYLES.map(([v, l]) => `<option value="${escapeHtml(v)}" ${(selected || '') === v ? 'selected' : ''}>${l}</option>`).join('');
}

// Apply a channel's production defaults (voice, visual style, subtitles) to the
// current project's Studio inputs, so a manually-opened project matches what
// Autopilot would use. (Was referenced but never defined — a latent crash.)
function applyChannelDefaults(channelId) {
  const ch = (plannerState.channels || []).find(c => c.id === channelId);
  const d = ch && ch.defaults;
  if (!d) return;
  if (d.voice) setInputValue('nleVoiceSelect', d.voice);
  if (d.visualStyle) setInputValue('explainerStyle', d.visualStyle);
  if (d.subPosition && d.subPosition !== 'none') setInputValue('nleSubPosition', d.subPosition);
  scheduleProjectSave();
}

async function refreshChannelManagerYouTubeStatus(card, channel) {
  if (!card || !card.isConnected || channel.platform === 'instagram') return;
  const status = card.querySelector('.cm-yt-status');
  const connect = card.querySelector('.cm-yt-connect');
  const disconnect = card.querySelector('.cm-yt-disconnect');
  if (!status || !connect || !disconnect) return;
  try {
    const response = await fetch(`/api/youtube/status?channelId=${encodeURIComponent(channel.id)}`);
    const data = await response.json();
    if (!data.configured) {
      status.textContent = 'OAuth is not configured on this server.';
      status.dataset.state = 'error';
      connect.hidden = true;
      disconnect.hidden = true;
      return;
    }
    if (data.connected) {
      status.textContent = `Connected to ${data.channel}`;
      status.title = `Uploads for ${channel.name} use the saved token for YouTube channel ${data.channel}.`;
      status.dataset.state = 'connected';
      connect.textContent = 'Reconnect';
      connect.hidden = false;
      disconnect.hidden = false;
    } else {
      status.textContent = data.error ? `Connection needs attention: ${data.error}` : 'Not connected';
      status.title = `Connect the YouTube account that owns the destination channel for ${channel.name}.`;
      status.dataset.state = data.error ? 'error' : 'idle';
      connect.textContent = 'Connect YouTube';
      connect.hidden = false;
      disconnect.hidden = true;
    }
  } catch {
    status.textContent = 'Could not check YouTube connection';
    status.dataset.state = 'error';
  }
}

async function pollChannelManagerYouTubeStatus(card, channel) {
  for (let attempt = 0; attempt < 30 && card.isConnected; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await refreshChannelManagerYouTubeStatus(card, channel);
    if (card.querySelector('.cm-yt-status')?.dataset.state === 'connected') return;
  }
}

function renderChannelManager() {
  const holder = document.getElementById('channelManager');
  if (!holder) return;
  if (!plannerState.channels.length) {
    holder.innerHTML = '<p class="section-desc">No channels yet — add one with the "Add Channel" button above.</p>';
    return;
  }

  holder.innerHTML = plannerState.channels.map(ch => {
    const brandRefs = ch.brandRefs || [];
    const logo = ch.logo ? `/outputs/${ch.logo}` : null;
    const d = ch.defaults || {};
    return `
    <div class="cm-card" data-ch="${ch.id}">
      <div class="cm-row">
        <input type="text" class="text-input cm-name" value="${escapeHtml(ch.name)}" title="Channel name">
        <select class="select-input cm-platform" title="Platform">
          <option value="youtube" ${ch.platform !== 'instagram' ? 'selected' : ''}>YouTube</option>
          <option value="instagram" ${ch.platform === 'instagram' ? 'selected' : ''}>Instagram</option>
        </select>
        <select class="select-input cm-type" title="Content type — music channels open ideas in the song + character flow">
          <option value="" ${!ch.contentType ? 'selected' : ''}>Auto (${channelIsMusic(ch) ? '🎵 music' : '🎬 explainer'})</option>
          <option value="music" ${ch.contentType === 'music' ? 'selected' : ''}>🎵 Music videos</option>
          <option value="explainer" ${ch.contentType === 'explainer' ? 'selected' : ''}>🎬 Explainer</option>
        </select>
        <button class="btn btn-secondary btn-sm cm-delete" title="Remove channel (its videos stay, unassigned)">✕ Delete</button>
      </div>
      <div class="cm-row">
        <input type="text" class="text-input cm-niche" value="${escapeHtml(ch.niche || '')}" placeholder="Niche (drives idea suggestions & song style)">
        <input type="text" class="text-input cm-subreddit" value="${escapeHtml(ch.subreddit || '')}" placeholder="Related subreddit (optional)" style="max-width: 220px;">
      </div>

      ${ch.platform === 'instagram' ? '' : `
      <div class="cm-youtube">
        <div class="cm-youtube-identity">
          <span class="cm-youtube-label">YouTube destination</span>
          <span class="cm-yt-status" data-state="loading">Checking connection...</span>
        </div>
        <div class="cm-youtube-actions">
          <button class="btn btn-secondary btn-sm cm-yt-connect" type="button" hidden>Connect YouTube</button>
          <button class="btn btn-secondary btn-sm cm-yt-disconnect" type="button" hidden>Disconnect</button>
        </div>
      </div>`}

      <div class="cm-defaults-row" style="margin-top: 0.6rem; padding: 0.6rem 0.8rem; background: rgba(15, 23, 42, 0.6); border-radius: 8px; border: 1px solid rgba(139, 92, 246, 0.25);">
        <div style="font-size: 0.78rem; font-weight: 700; color: #a78bfa; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 0.4rem;">
          ⚙️ Channel Production Defaults <span style="font-weight: 400; color: #94a3b8; text-transform: none;">(auto-applies voice, cards &amp; subtitles to videos for this channel)</span>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 0.75rem 1.2rem; align-items: center;">
          <div style="display: flex; align-items: center; gap: 0.35rem;">
            <span style="font-size: 0.8rem; color: #cbd5e1; font-weight: 600;">Voice:</span>
            <select class="select-input cm-def-voice" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; min-width: 120px;">
              <option value="Puck" ${!d.voice || d.voice === 'Puck' ? 'selected' : ''}>Puck (upbeat)</option>
              <option value="Kore" ${d.voice === 'Kore' ? 'selected' : ''}>Kore (warm)</option>
              <option value="Charon" ${d.voice === 'Charon' ? 'selected' : ''}>Charon (deep)</option>
              <option value="Fenrir" ${d.voice === 'Fenrir' ? 'selected' : ''}>Fenrir (strong)</option>
              <option value="Aoede" ${d.voice === 'Aoede' ? 'selected' : ''}>Aoede (bright)</option>
              <option value="Leda" ${d.voice === 'Leda' ? 'selected' : ''}>Leda (soft)</option>
            </select>
          </div>

          <div style="display: flex; align-items: center; gap: 0.35rem;">
            <span style="font-size: 0.8rem; color: #cbd5e1; font-weight: 600;">Intro Card:</span>
            <input type="number" class="number-input cm-def-intro-dur" value="${d.introDuration !== undefined ? d.introDuration : 2}" min="1" max="15" step="0.5" style="width: 55px; padding: 0.2rem 0.4rem; font-size: 0.8rem;" title="Intro card duration in seconds">
            <span style="font-size: 0.75rem; color: #94a3b8;">s</span>
            <label class="chk-label" style="font-size: 0.78rem; margin-left: 0.25rem;">
              <input type="checkbox" class="cm-def-intro-hidetext" ${d.introHideText !== false ? 'checked' : ''}> <span>Hide Text</span>
            </label>
          </div>

          <div style="display: flex; align-items: center; gap: 0.35rem;">
            <span style="font-size: 0.8rem; color: #cbd5e1; font-weight: 600;">Outro Card:</span>
            <input type="number" class="number-input cm-def-outro-dur" value="${d.outroDuration !== undefined ? d.outroDuration : 4}" min="1" max="15" step="0.5" style="width: 55px; padding: 0.2rem 0.4rem; font-size: 0.8rem;" title="Outro card duration in seconds">
            <span style="font-size: 0.75rem; color: #94a3b8;">s</span>
            <label class="chk-label" style="font-size: 0.78rem; margin-left: 0.25rem;">
              <input type="checkbox" class="cm-def-outro-hidetext" ${d.outroHideText !== false ? 'checked' : ''}> <span>Hide Text</span>
            </label>
          </div>

          <div style="display: flex; align-items: center; gap: 0.35rem;">
            <span style="font-size: 0.8rem; color: #cbd5e1; font-weight: 600;">Subtitles:</span>
            <select class="select-input cm-def-subs" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">
              <option value="none" ${d.subPosition === 'none' || d.subPosition === false || !d.subPosition ? 'selected' : ''}>Disabled (YouTube CC)</option>
              <option value="bottom" ${d.subPosition === 'bottom' ? 'selected' : ''}>Burnt-in Bottom</option>
              <option value="top" ${d.subPosition === 'top' ? 'selected' : ''}>Burnt-in Top</option>
              <option value="middle" ${d.subPosition === 'middle' ? 'selected' : ''}>Burnt-in Middle</option>
            </select>
          </div>

          <div style="display: flex; align-items: center; gap: 0.35rem;">
            <span style="font-size: 0.8rem; color: #cbd5e1; font-weight: 600;">Visual Style:</span>
            <select class="select-input cm-def-style" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; min-width: 160px;" title="Visual style Autopilot uses when generating videos for this channel">
              ${visualStyleOptions(d.visualStyle)}
            </select>
          </div>
        </div>
      </div>

      <div class="cm-assets">
        <div class="cm-asset cm-brand-asset">
          <span class="cm-asset-label">Brand kit <span class="pc-hint">up to 6 images — style AI scenes, covers &amp; thumbnails</span></span>
          <div class="cm-gallery">
            ${brandRefs.map(f => `
            <span class="cm-gal-item">
              <img class="cm-thumb" src="/outputs/${f}" alt="" title="${escapeHtml(f)}">
              <button class="cm-gal-rm" data-cm-brand-rmfile="${ch.id}|${escapeHtml(f)}" title="Remove this image">×</button>
            </span>`).join('')}
            ${brandRefs.length ? '' : '<span class="cm-empty">none</span>'}
          </div>
          <button class="btn btn-secondary btn-sm" data-cm-brand-up="${ch.id}">+ Add</button>
          <button class="btn btn-secondary btn-sm" data-cm-brand-gen="${ch.id}" title="AI generates a cohesive kit: key art, character model sheet & scene style frame — matching any images already here">✦ Generate Kit</button>
        </div>
        <div class="cm-asset">
          <span class="cm-asset-label">Logo <span class="pc-hint">watermarked on every video</span></span>
          ${logo ? `<img class="cm-thumb cm-thumb-logo" src="${logo}" alt="">` : '<span class="cm-empty">none</span>'}
          <button class="btn btn-secondary btn-sm" data-cm-logo-up="${ch.id}">${logo ? 'Replace' : 'Upload'}</button>
          <button class="btn btn-secondary btn-sm" data-cm-logo-gen="${ch.id}">✦ AI</button>
          ${logo ? `<button class="btn btn-secondary btn-sm" data-cm-logo-rm="${ch.id}">Remove</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  // Field edits commit on change (blur/enter) so typing never loses focus
  holder.querySelectorAll('.cm-card').forEach(card => {
    const ch = plannerState.channels.find(c => c.id === card.dataset.ch);
    if (!ch) return;
    const commit = () => {
      const name = card.querySelector('.cm-name').value.trim();
      if (name) ch.name = name;
      ch.platform = card.querySelector('.cm-platform').value;
      ch.contentType = card.querySelector('.cm-type').value || null;
      ch.niche = card.querySelector('.cm-niche').value.trim();
      ch.subreddit = card.querySelector('.cm-subreddit').value.trim();
      ch.defaults = {
        voice: card.querySelector('.cm-def-voice').value,
        introDuration: parseFloat(card.querySelector('.cm-def-intro-dur').value) || 2,
        introHideText: card.querySelector('.cm-def-intro-hidetext').checked,
        outroDuration: parseFloat(card.querySelector('.cm-def-outro-dur').value) || 4,
        outroHideText: card.querySelector('.cm-def-outro-hidetext').checked,
        subPosition: card.querySelector('.cm-def-subs').value,
        visualStyle: card.querySelector('.cm-def-style').value || null
      };
      savePlanner();
      renderPlanner(); // chips, table, autopilot rows and this manager all reflect it
      if (state.channelId === ch.id) applyChannelDefaults(ch.id);
      showToast(`Channel "${ch.name}" defaults updated.`, 'success');
    };
    card.querySelectorAll('.cm-name, .cm-platform, .cm-type, .cm-niche, .cm-subreddit, .cm-def-voice, .cm-def-intro-dur, .cm-def-intro-hidetext, .cm-def-outro-dur, .cm-def-outro-hidetext, .cm-def-subs, .cm-def-style').forEach(el => {
      el.addEventListener('change', commit);
    });
    const connectYouTube = card.querySelector('.cm-yt-connect');
    if (connectYouTube) connectYouTube.addEventListener('click', async () => {
      connectYouTube.disabled = true;
      const response = await fetch('/api/youtube/auth/system', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: ch.id })
      });
      const data = await response.json();
      connectYouTube.disabled = false;
      if (!response.ok) {
        showToast(data.error || 'Could not open YouTube authorization.', 'error');
        return;
      }
      showToast(`Authorize the YouTube destination for "${ch.name}" in your system browser.`, 'info');
      pollChannelManagerYouTubeStatus(card, ch);
    });
    const disconnectYouTube = card.querySelector('.cm-yt-disconnect');
    if (disconnectYouTube) disconnectYouTube.addEventListener('click', async () => {
      if (!confirm(`Disconnect the saved YouTube destination from "${ch.name}"?`)) return;
      disconnectYouTube.disabled = true;
      const response = await fetch('/api/youtube/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: ch.id })
      });
      disconnectYouTube.disabled = false;
      if (!response.ok) {
        const data = await response.json();
        showToast(data.error || 'Could not disconnect YouTube.', 'error');
        return;
      }
      showToast(`YouTube disconnected from "${ch.name}".`, 'info');
      refreshChannelManagerYouTubeStatus(card, ch);
    });
    card.querySelector('.cm-delete').addEventListener('click', () => {
      if (!confirm(`Remove channel "${ch.name}"? Its videos stay, unassigned.`)) return;
      plannerState.channels = plannerState.channels.filter(c => c.id !== ch.id);
      plannerState.videos.forEach(v => { if (v.channelId === ch.id) v.channelId = null; });
      savePlanner();
      renderPlanner();
    });
    refreshChannelManagerYouTubeStatus(card, ch);
  });

  // Asset buttons
  holder.querySelectorAll('[data-cm-brand-up]').forEach(b => b.addEventListener('click', () => {
    cmFileTarget = { channelId: b.dataset.cmBrandUp, kind: 'brand' };
    document.getElementById('cmFileInput').click();
  }));
  holder.querySelectorAll('[data-cm-logo-up]').forEach(b => b.addEventListener('click', () => {
    cmFileTarget = { channelId: b.dataset.cmLogoUp, kind: 'logo' };
    document.getElementById('cmFileInput').click();
  }));
  holder.querySelectorAll('[data-cm-brand-rmfile]').forEach(b => b.addEventListener('click', async () => {
    const [channelId, file] = b.dataset.cmBrandRmfile.split('|');
    await fetch('/api/channel-brand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId, removeFile: file }) });
    await refreshChannelAssets(channelId);
  }));
  holder.querySelectorAll('[data-cm-brand-gen]').forEach(b => b.addEventListener('click', async () => {
    const ch = plannerState.channels.find(c => c.id === b.dataset.cmBrandGen);
    if (!ch) return;
    b.disabled = true;
    b.innerText = 'Designing kit… (~1 min)';
    showToast(`AI is building a brand kit for "${ch.name}" — key art, character sheet & style frame…`, 'info');
    try {
      const res = await fetch('/api/generate-brand-kit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: ch.id })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'generation failed');
      await refreshChannelAssets(ch.id);
      showToast(`Brand kit ready: ${data.created.length} new image(s) — all AI content for "${ch.name}" now follows this style.`, 'success');
    } catch (err) {
      showToast(`Brand kit generation failed: ${err.message}`, 'error');
      b.disabled = false;
      b.innerText = '✦ Generate Kit';
    }
  }));
  holder.querySelectorAll('[data-cm-logo-rm]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remove this channel\'s logo?')) return;
    await fetch('/api/channel-logo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: b.dataset.cmLogoRm, remove: true }) });
    await refreshChannelAssets(b.dataset.cmLogoRm);
  }));
  holder.querySelectorAll('[data-cm-logo-gen]').forEach(b => b.addEventListener('click', async () => {
    const ch = plannerState.channels.find(c => c.id === b.dataset.cmLogoGen);
    if (!ch) return;
    b.disabled = true;
    b.innerText = 'Generating…';
    try {
      const referenceImages = [];
      for (const f of (ch.brandRefs || []).slice(0, 2)) {
        try { referenceImages.push(await urlToBase64(`/outputs/${f}`)); } catch {}
      }
      const res = await fetch('/api/generate-logo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: ch.id, channelName: ch.name, niche: ch.niche || '', referenceImages })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'generation failed');
      await refreshChannelAssets(ch.id);
      showToast(`Logo generated for "${ch.name}" — it now watermarks every video.`, 'success');
    } catch (err) {
      showToast(`Logo generation failed: ${err.message}`, 'error');
      b.disabled = false;
      b.innerText = '✦ AI';
    }
  }));
}

// Pull the server's copy of one channel's assets back into the local planner state
async function refreshChannelAssets(channelId) {
  try {
    const res = await fetch('/api/planner');
    const fresh = (await res.json()).channels || [];
    const updated = fresh.find(c => c.id === channelId);
    const local = plannerState.channels.find(c => c.id === channelId);
    if (updated && local) {
      local.brandRefs = updated.brandRefs || [];
      local.logo = updated.logo || null;
    }
  } catch { /* next full reload will catch up */ }
  channelListCache = null; // the Studio's cached channel list is stale now
  renderPlanner();
  updateChannelBrandInfo();
  updateLogoUI();
}

function startAutopilotPolling() {
  renderAutopilotQueue();
  if (!apPollTimer) apPollTimer = setInterval(renderAutopilotQueue, 5000);
}

function stopAutopilotPolling() {
  if (apPollTimer) { clearInterval(apPollTimer); apPollTimer = null; }
}

/* ---------------- Trend Watch (scheduled trends agent) ---------------- */

// Force re-fetch planner videos (Trend Watch adds ideas server-side)
async function reloadPlannerFromServer() {
  plannerState.loaded = false;
  await ensurePlannerLoaded();
}

async function loadTrendWatchStatus() {
  try {
    const res = await fetch('/api/trend-watch');
    if (!res.ok) return;
    const tw = await res.json();

    const chk = document.getElementById('twEnabled');
    const interval = document.getElementById('twInterval');
    const status = document.getElementById('twStatus');
    const info = document.getElementById('twInfo');
    const isRemote = tw.mode === 'remote';

    // In cloud mode the schedule lives in Cloud Scheduler — local controls are moot
    if (chk) {
      chk.checked = tw.enabled;
      chk.disabled = isRemote;
    }
    if (interval) {
      if (!isRemote) interval.value = String(tw.intervalHours || 5);
      interval.disabled = isRemote;
    }

    if (status) {
      if (isRemote) {
        status.innerText = tw.running ? 'Cloud · running…' : (tw.remoteReachable ? 'Cloud' : 'Cloud · unreachable');
        status.className = `tw-status ${tw.running ? 'running' : (tw.remoteReachable ? 'on' : 'off')}`;
      } else {
        status.innerText = tw.running ? 'Running…' : (tw.enabled ? `On · every ${tw.intervalHours}h` : 'Off');
        status.className = `tw-status ${tw.running ? 'running' : (tw.enabled ? 'on' : 'off')}`;
      }
      // Mirror onto the collapsed-section chip so state is visible without expanding
      // (textContent: innerText reads as '' from inside a closed <details>)
      const chip = document.getElementById('twStatusChip');
      if (chip) { chip.textContent = status.textContent; chip.className = status.className; }
    }
    if (info) {
      const bits = [];
      if (isRemote) {
        bits.push(`Cloud agent: ${tw.remoteUrl.replace(/^https?:\/\//, '')}`);
        if (!tw.remoteReachable) bits.push('not reachable right now');
        if (tw.lastRun) bits.push(`Last run: ${new Date(tw.lastRun).toLocaleString()}`);
        if (typeof tw.pendingIdeas === 'number') bits.push(`${tw.pendingIdeas} idea(s) pending sync`);
        bits.push('Schedule & digest email are configured on Google Cloud');
      } else {
        if (tw.lastRun) bits.push(`Last run: ${new Date(tw.lastRun).toLocaleString()}`);
        if (tw.enabled && tw.nextRun) bits.push(`Next: ~${new Date(tw.nextRun).toLocaleTimeString()}`);
        bits.push(tw.emailConfigured
          ? `Digest email → ${tw.emailTo}`
          : 'Email not configured (set SMTP_* + DIGEST_EMAIL_TO in .env) — using macOS notifications');
      }
      info.innerText = bits.join(' · ');
      info.style.color = 'var(--color-text-muted)';
    }
    renderTrendWatchDigest(tw.digests || []);

    // Cloud mode: pull any ideas the agent found since we last looked
    if (isRemote && tw.remoteReachable && (tw.pendingIdeas || 0) > 0) {
      syncCloudIdeas();
    }
  } catch (err) {
    console.warn('Trend Watch status load failed:', err);
  }
}

// Pull pending cloud ideas into the planner (no-op in local mode)
let cloudSyncInFlight = false;
async function syncCloudIdeas() {
  if (cloudSyncInFlight) return;
  cloudSyncInFlight = true;
  try {
    const res = await fetch('/api/trend-watch/sync', { method: 'POST' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.mode === 'remote' && data.imported > 0) {
      await reloadPlannerFromServer();
      showToast(`Synced ${data.imported} new idea${data.imported > 1 ? 's' : ''} from the cloud Trend Watch agent.`, 'success');
    }
  } catch (err) {
    console.warn('Cloud idea sync failed:', err);
  } finally {
    cloudSyncInFlight = false;
  }
}

function renderTrendWatchDigest(digests) {
  const holder = document.getElementById('twDigest');
  if (!holder) return;
  if (!digests.length) { holder.innerHTML = ''; return; }

  const d = digests[0];
  const lines = d.channels.map(ch => ch.error
    ? `<li>${escHtml(ch.channelName)}: <span class="muted">failed (${escHtml(ch.error.slice(0, 60))})</span></li>`
    : `<li><strong>${escHtml(ch.channelName)}</strong>: ${ch.ideas.length} new idea${ch.ideas.length === 1 ? '' : 's'}${ch.ideas.length ? ' — ' + ch.ideas.map(i => escHtml(i.title)).join(' · ') : ''}</li>`
  ).join('');

  holder.innerHTML = `
    <div class="tw-digest-card">
      <div class="tw-digest-head">Latest digest — ${new Date(d.at).toLocaleString()} · ${d.totalNewIdeas} new ideas
        ${d.emailed ? '<span class="tw-mail ok">emailed</span>' : '<span class="tw-mail">no email</span>'}</div>
      <ul>${lines}</ul>
    </div>`;
}

async function saveTrendWatchSettings() {
  const enabled = document.getElementById('twEnabled').checked;
  const intervalHours = parseInt(document.getElementById('twInterval').value, 10) || 5;
  try {
    const res = await fetch('/api/trend-watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, intervalHours })
    });
    if (!res.ok) throw new Error('save failed');
    showToast(enabled
      ? `Trend Watch on — checking trends every ${intervalHours}h while the server runs.`
      : 'Trend Watch turned off.', 'success');
    loadTrendWatchStatus();
  } catch (err) {
    showToast('Could not update Trend Watch settings.', 'error');
  }
}

async function runTrendWatchNow() {
  const btn = document.getElementById('btnTwRunNow');
  btn.disabled = true;
  btn.innerText = 'Running (may take a minute)…';
  try {
    const res = await fetch('/api/trend-watch/run-now', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Run failed');
    const added = data.mode === 'remote' ? data.imported : data.digest.totalNewIdeas;
    const emailed = data.digest && data.digest.emailed;
    showToast(`Trend Watch added ${added} new idea${added === 1 ? '' : 's'}${emailed ? ' and emailed you the digest' : ''}${data.mode === 'remote' ? ' (cloud agent)' : ''}.`, 'success');
    await reloadPlannerFromServer();
    loadTrendWatchStatus();
  } catch (err) {
    showToast(`Trend Watch run failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Run Now';
  }
}

function channelById(id) {
  return plannerState.channels.find(c => c.id === id) || null;
}

/* -------- Channel brand kit upload (🎨 on channel chips) -------- */

let pendingBrandChannelId = null;

function openChannelBrandPicker(channelId) {
  pendingBrandChannelId = channelId;
  let input = document.getElementById('channelBrandInput');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.id = 'channelBrandInput';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      const channelId2 = pendingBrandChannelId;
      pendingBrandChannelId = null;
      if (!file || !channelId2 || !file.type.startsWith('image/')) return;
      try {
        const dataUrl = await downscaleImageFile(file, 768);
        const res = await fetch('/api/channel-brand', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: channelId2, imageBase64: dataUrl })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'upload failed');
        const data = await res.json();
        const ch = channelById(channelId2);
        if (ch) ch.brandRefs = data.brandRefs;
        channelListCache = null; // studio pickers refetch fresh kits
        renderPlanner();
        updateChannelBrandInfo();
        showToast(`Brand kit saved for "${ch ? ch.name : 'channel'}" — its projects' AI images will match this art.`, 'success');
      } catch (err) {
        console.error(err);
        showToast(`Brand kit upload failed: ${err.message}`, 'error');
      }
    });
  }
  input.click();
}

function renderPlanner() {
  const chips = document.getElementById('channelChips');
  const filter = document.getElementById('plannerChannelFilter');
  const videoChannelInput = document.getElementById('videoChannelInput');
  const tbody = document.getElementById('plannerTableBody');
  const emptyHint = document.getElementById('plannerEmptyHint');
  if (!chips || !filter || !tbody) return;

  const currentFilter = filter.value;

  // Channel chips
  chips.innerHTML = plannerState.channels.map(c => `
    <span class="channel-chip ${currentFilter === c.id ? 'active' : ''}" data-id="${c.id}">
      <span class="chip-platform ${c.platform}">${c.platform === 'instagram' ? 'IG' : 'YT'}</span>
      ${escHtml(c.name)}
      <span class="chip-type" title="${channelIsMusic(c) ? 'Music channel — ideas open in the song + character flow' : 'Explainer channel — ideas open in the narrated video flow'}">${channelIsMusic(c) ? '🎵' : '🎬'}</span>
      <span class="chip-count">${plannerState.videos.filter(v => v.channelId === c.id).length}</span>
      <button class="chip-brand ${c.brandRefs && c.brandRefs.length ? 'has-brand' : ''}" data-brand="${c.id}" title="${c.brandRefs && c.brandRefs.length ? 'Brand kit set — click to replace' : 'Set brand kit (album cover / character art)'}">🎨</button>
      <button class="chip-delete" data-del="${c.id}" title="Remove channel">×</button>
    </span>
  `).join('');

  chips.querySelectorAll('.chip-brand').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openChannelBrandPicker(btn.dataset.brand);
    });
  });

  chips.querySelectorAll('.channel-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      if (e.target.dataset.del) return;
      filter.value = filter.value === chip.dataset.id ? '' : chip.dataset.id;
      plannerPage = 1;
      renderPlanner();
    });
  });
  chips.querySelectorAll('.chip-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const ch = channelById(btn.dataset.del);
      if (!confirm(`Remove channel "${ch ? ch.name : ''}"? Its videos stay, unassigned.`)) return;
      plannerState.channels = plannerState.channels.filter(c => c.id !== btn.dataset.del);
      plannerState.videos.forEach(v => { if (v.channelId === btn.dataset.del) v.channelId = null; });
      if (filter.value === btn.dataset.del) filter.value = '';
      savePlanner();
      renderPlanner();
    });
  });

  // Filter + form channel selects
  const channelOptions = plannerState.channels.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  filter.innerHTML = `<option value="">All Channels</option>${channelOptions}`;
  filter.value = currentFilter;
  if (videoChannelInput) {
    const prev = videoChannelInput.value;
    videoChannelInput.innerHTML = `<option value="">— No channel —</option>${channelOptions}`;
    videoChannelInput.value = prev;
  }

  // Status filter options (populated once, selection preserved)
  const statusFilterEl = document.getElementById('plannerStatusFilter');
  if (statusFilterEl && statusFilterEl.options.length <= 1) {
    statusFilterEl.innerHTML = '<option value="">All Statuses</option>' +
      PLANNER_STATUSES.map(s => `<option value="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('');
  }
  const statusFilter = statusFilterEl ? statusFilterEl.value : '';
  const sortMode = (document.getElementById('plannerSort') || {}).value || 'schedule';
  const ROI_ORDER = { high: 3, medium: 2, low: 1 };

  // Video table
  const videos = plannerState.videos
    .filter(v => (!currentFilter || v.channelId === currentFilter) && (!statusFilter || v.status === statusFilter))
    .sort((a, b) => {
      if (sortMode === 'roi') {
        return (ROI_ORDER[b.roi && b.roi.potential] || 0) - (ROI_ORDER[a.roi && a.roi.potential] || 0) || (b.createdAt || 0) - (a.createdAt || 0);
      }
      if (sortMode === 'newest') return (b.createdAt || 0) - (a.createdAt || 0);
      return (a.scheduledDate || '9999-99-99').localeCompare(b.scheduledDate || '9999-99-99') || (a.createdAt || 0) - (b.createdAt || 0);
    });
  const totalPages = Math.max(1, Math.ceil(videos.length / PLANNER_PAGE_SIZE));
  plannerPage = Math.min(Math.max(1, plannerPage), totalPages);
  const pageStart = (plannerPage - 1) * PLANNER_PAGE_SIZE;
  const visibleVideos = videos.slice(pageStart, pageStart + PLANNER_PAGE_SIZE);

  const SOURCE_BADGES = {
    agent: { label: 'AI Idea', cls: 'src-agent', hint: 'Suggested by the viral topics agent' },
    radar: { label: 'Trend Radar', cls: 'src-watch', hint: 'Found by the live multi-source Trend Radar' },
    watch: { label: 'Trend Watch', cls: 'src-watch', hint: 'Found automatically by the scheduled Trend Watch agent' },
    studio: { label: 'Studio', cls: 'src-studio', hint: 'Rendered in the Studio and added here' },
    manual: { label: 'Manual', cls: 'src-manual', hint: 'Added by hand' }
  };

  tbody.innerHTML = visibleVideos.map(v => {
    const ch = channelById(v.channelId);
    const src = SOURCE_BADGES[v.source] || SOURCE_BADGES.manual;
    const vKeyPoints = (v.keyPoints || []).filter(Boolean);
    const hasDetail = !!(v.whyViral || v.hook || v.angle || vKeyPoints.length || v.bestPostTime || (v.roi && (v.roi.views || v.roi.rationale)) || v.stats);

    const roiChip = v.roi && v.roi.potential
      ? `<span class="roi-chip roi-${v.roi.potential}" title="${escHtml([v.roi.views, v.roi.revenue].filter(Boolean).join(' · '))}">${v.roi.potential.charAt(0).toUpperCase() + v.roi.potential.slice(1)}</span>`
      : '<span class="muted">—</span>';

    const detailRow = hasDetail ? `
    <tr class="planner-detail-row" data-detail="${v.id}" style="display: none;">
      <td colspan="8">
        <div class="planner-detail">
          ${v.whyViral ? `<div class="pd-item"><span class="pd-label">Why it matters</span>${escHtml(v.whyViral)}</div>` : ''}
          ${v.hook ? `<div class="pd-item"><span class="pd-label">Hook</span>${escHtml(v.hook)}</div>` : ''}
          ${v.angle ? `<div class="pd-item"><span class="pd-label">Angle</span>${escHtml(v.angle)}</div>` : ''}
          ${vKeyPoints.length ? `<div class="pd-item"><span class="pd-label">Key points</span><ul class="pd-points">${vKeyPoints.map(p => `<li>${escHtml(p)}</li>`).join('')}</ul></div>` : ''}
          ${v.targetAudience ? `<div class="pd-item"><span class="pd-label">Audience</span>${escHtml(v.targetAudience)}</div>` : ''}
          ${v.bestPostTime ? `<div class="pd-item"><span class="pd-label">Best time</span>${escHtml(v.bestPostTime)}</div>` : ''}
          ${v.roi && (v.roi.views || v.roi.revenue) ? `<div class="pd-item"><span class="pd-label">Est. ROI</span>${escHtml([v.roi.views, v.roi.revenue].filter(Boolean).join(' → '))}${v.roi.rationale ? ` — ${escHtml(v.roi.rationale)}` : ''}<span class="pd-disclaimer">AI estimate for a new/small channel — for comparing ideas, not a guarantee.</span></div>` : ''}
          ${v.stats ? `<div class="pd-item"><span class="pd-label">Actual</span>${formatCount(v.stats.views)} views · ${formatCount(v.stats.likes)} likes · ${formatCount(v.stats.comments)} comments${v.roi && v.roi.views ? ` (estimate was ${escHtml(v.roi.views)})` : ''}</div>` : ''}
        </div>
      </td>
    </tr>` : '';

    return `
    <tr data-id="${v.id}">
      <td class="planner-added" title="${v.createdAt ? new Date(v.createdAt).toLocaleString() : ''}">${v.createdAt ? new Date(v.createdAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) : '—'}</td>
      <td><input type="date" class="text-input planner-date" value="${v.scheduledDate || ''}" data-id="${v.id}"></td>
      <td>
        <span class="planner-title">${escHtml(v.title)}</span>
        ${v.publishedUrl ? `<a class="pub-link" href="${escHtml(v.publishedUrl)}" target="_blank" rel="noopener" title="Open on YouTube">↗</a>` : ''}
        <span class="source-badge ${src.cls}" title="${src.hint}">${src.label}</span>
        ${hasDetail ? `<button class="pd-toggle" data-toggle="${v.id}" title="Why this video & estimated ROI">Why?</button>` : ''}
        ${v.stats ? `<span class="stats-chip" title="Real YouTube stats (fetched ${new Date(v.stats.fetchedAt).toLocaleString()})">▶ ${formatCount(v.stats.views)} · 👍 ${formatCount(v.stats.likes)}</span>` : ''}
      </td>
      <td>${ch ? escHtml(ch.name) : '<span class="muted">—</span>'}</td>
      <td>${PLANNER_FORMAT_LABELS[v.format] || v.format || '—'}</td>
      <td>${roiChip}</td>
      <td>
        <select class="select-input planner-status status-${v.status}" data-id="${v.id}">
          ${PLANNER_STATUSES.map(s => `<option value="${s}" ${v.status === s ? 'selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
        </select>
      </td>
      <td class="planner-row-actions">
        ${(v.topic || v.videoPrompt) ? `<button class="btn btn-secondary btn-sm" data-open="${v.id}">Open in Studio</button>` : ''}
        ${['idea', 'planned', 'ready'].includes(v.status) ? `<button class="btn btn-secondary btn-sm btn-autopilot" data-autopilot="${v.id}" title="Produce & schedule this video hands-free">🚀 Autopilot</button>` : ''}
        <button class="btn btn-secondary btn-sm" data-remove="${v.id}" title="Delete">✕</button>
      </td>
    </tr>${detailRow}`;
  }).join('');

  if (emptyHint) emptyHint.style.display = videos.length === 0 ? 'block' : 'none';

  const pagination = document.getElementById('plannerPagination');
  if (pagination) {
    if (videos.length === 0) {
      pagination.innerHTML = '';
    } else {
      const firstShown = pageStart + 1;
      const lastShown = Math.min(pageStart + PLANNER_PAGE_SIZE, videos.length);
      const pageNumbers = Array.from({ length: totalPages }, (_, index) => index + 1)
        .filter(page => totalPages <= 7 || page === 1 || page === totalPages || Math.abs(page - plannerPage) <= 1);
      let previousPage = 0;
      const numberButtons = pageNumbers.map(page => {
        const gap = previousPage && page - previousPage > 1 ? '<span class="planner-page-gap" aria-hidden="true">…</span>' : '';
        previousPage = page;
        return `${gap}<button class="planner-page-btn ${page === plannerPage ? 'active' : ''}" data-planner-page="${page}" ${page === plannerPage ? 'aria-current="page"' : ''}>${page}</button>`;
      }).join('');
      pagination.innerHTML = `
        <span class="planner-page-summary">Showing ${firstShown}–${lastShown} of ${videos.length}</span>
        <div class="planner-page-controls">
          <button class="planner-page-btn planner-page-nav" data-planner-page="${plannerPage - 1}" ${plannerPage === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
          ${numberButtons}
          <button class="planner-page-btn planner-page-nav" data-planner-page="${plannerPage + 1}" ${plannerPage === totalPages ? 'disabled' : ''} aria-label="Next page">›</button>
        </div>`;
      pagination.querySelectorAll('[data-planner-page]:not([disabled])').forEach(button => {
        button.addEventListener('click', () => {
          plannerPage = parseInt(button.dataset.plannerPage, 10);
          renderPlanner();
          document.querySelector('.planner-table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }
  }

  // Row interactions
  tbody.querySelectorAll('.planner-date').forEach(input => {
    input.addEventListener('change', () => {
      const video = plannerState.videos.find(v => v.id === input.dataset.id);
      if (video) { video.scheduledDate = input.value; savePlanner(); }
    });
  });
  tbody.querySelectorAll('.planner-status').forEach(sel => {
    sel.addEventListener('change', () => {
      const video = plannerState.videos.find(v => v.id === sel.dataset.id);
      if (video) {
        video.status = sel.value;
        sel.className = `select-input planner-status status-${sel.value}`;
        // Published → ask for the YouTube URL so we can track real performance
        if (sel.value === 'published' && !video.publishedUrl) {
          const url = prompt('YouTube URL of the published video (optional — enables real stats):', '');
          if (url && url.trim()) {
            video.publishedUrl = url.trim();
            renderPlanner();
          }
        }
        savePlanner();
      }
    });
  });
  tbody.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = tbody.querySelector(`[data-detail="${btn.dataset.toggle}"]`);
      if (row) {
        const open = row.style.display !== 'none';
        row.style.display = open ? 'none' : 'table-row';
        btn.classList.toggle('open', !open);
      }
    });
  });
  tbody.querySelectorAll('[data-open]').forEach(btn => {
    btn.addEventListener('click', () => openIdeaInStudio(btn.dataset.open));
  });
  tbody.querySelectorAll('[data-autopilot]').forEach(btn => {
    btn.addEventListener('click', () => openAutopilotModal(btn.dataset.autopilot));
  });
  tbody.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      plannerState.videos = plannerState.videos.filter(v => v.id !== btn.dataset.remove);
      savePlanner();
      renderPlanner();
    });
  });

  renderFullAutopilotConfig();
  renderChannelManager();
}

// Send a planned idea into the Studio (explainer mode, prompt prefilled)
// Show/populate the editable brief panel from state.pendingBrief
function renderExplainerBrief() {
  const panel = document.getElementById('explainerBriefPanel');
  if (!panel) return;
  const b = state.pendingBrief;
  if (!b) { panel.style.display = 'none'; return; }
  setInputValue('briefAngle', b.angle || '');
  setInputValue('briefHook', b.hook || '');
  setInputValue('briefAudience', b.targetAudience || '');
  setInputValue('briefKeyPoints', (b.keyPoints || []).join('\n'));
  panel.style.display = 'block';
}

// Read the (possibly user-edited) brief back from the panel before generating
function readBriefFromPanel() {
  const panel = document.getElementById('explainerBriefPanel');
  if (!panel || panel.style.display === 'none') return state.pendingBrief || null;
  const keyPoints = (getInputValue('briefKeyPoints') || '').split('\n').map(s => s.trim()).filter(Boolean);
  const brief = {
    angle: (getInputValue('briefAngle') || '').trim(),
    hook: (getInputValue('briefHook') || '').trim(),
    targetAudience: (getInputValue('briefAudience') || '').trim(),
    keyPoints
  };
  if (!brief.angle && !brief.hook && !brief.targetAudience && keyPoints.length === 0) return null;
  return brief;
}

// Pack the researched context of a trend/idea into a brief for scene generation
function buildBrief(src) {
  const keyPoints = (src.keyPoints || []).filter(Boolean);
  if (!src.angle && !src.hook && keyPoints.length === 0 && !src.targetAudience) return null;
  return {
    angle: src.angle || '',
    hook: src.hook || '',
    keyPoints: keyPoints,
    targetAudience: src.targetAudience || ''
  };
}

// Snap a suggested duration to the closest option the Explainer picker offers
function applyExplainerDuration(seconds) {
  if (!explainerDuration || !seconds) return;
  const opts = [...explainerDuration.options].map(o => parseInt(o.value, 10));
  const nearest = opts.reduce((a, b) => Math.abs(b - seconds) < Math.abs(a - seconds) ? b : a, opts[0]);
  explainerDuration.value = String(nearest);
}

// Load a full trend brief into the Explainer studio (used by "Create Video")
function loadTrendIntoStudio(src) {
  state.pendingBrief = buildBrief(src);
  if (explainerTopicInput) explainerTopicInput.value = src.topic || src.title || '';
  applyExplainerDuration(src.suggestedDurationSeconds);

  setPlannerVisible(false);
  if (state.mode !== 'explainer') setProjectType('explainer');
  else goToStep(1);
  renderExplainerBrief();

  const n = state.pendingBrief ? state.pendingBrief.keyPoints.length : 0;
  showToast(`"${src.title}" loaded with its full brief${n ? ` (${n} key points)` : ''}. Generate the plan — scenes will follow the angle.`, 'success');
}

// File a radar topic into the planner, preserving its whole brief for later
function addTrendTopicToPlanner(t) {
  const ch = plannerState.channels[0];
  plannerState.videos.push({
    id: plannerId(),
    channelId: ch ? ch.id : null,
    title: t.title,
    topic: t.topic,
    format: ['long', 'short', 'reel'].includes(t.format) ? t.format : 'long',
    status: 'idea',
    scheduledDate: '',
    hook: t.hook,
    whyViral: t.whyViral,
    angle: t.angle,
    keyPoints: (t.keyPoints || []).filter(Boolean),
    targetAudience: t.targetAudience,
    suggestedDurationSeconds: t.suggestedDurationSeconds,
    videoPrompt: t.videoPrompt,
    viralScore: t.viralScore,
    source: 'radar',
    createdAt: Date.now()
  });
  savePlanner();
  renderPlanner();
  showToast(`"${t.title}" saved to the planner with its full content brief.`, 'success');
}

// Is this channel a MUSIC channel? Explicit contentType wins; otherwise inferred
// from the niche/name. Music channels always go through the song + character flow.
function channelIsMusic(ch) {
  if (!ch) return false;
  if (ch.contentType) return ch.contentType === 'music';
  return /song|music|rhyme|lullab|sing|tunes/i.test(`${ch.niche || ''} ${ch.name || ''}`);
}

// Turn an idea's brief into a Lyria-ready song description
function buildSongPromptFromIdea(v, ch) {
  const kp = (v.keyPoints || []).filter(Boolean);
  let p = `A complete song: ${v.topic || v.title}.`;
  if (v.hook) p += ` Open with: ${v.hook}`;
  if (kp.length) p += ` The verses should cover, in order: ${kp.join('; ')}.`;
  if (v.targetAudience) p += ` Audience: ${v.targetAudience}.`;
  if (ch && ch.niche) p += ` Style: ${ch.niche}.`;
  return p;
}

function openIdeaInStudio(videoId) {
  const video = plannerState.videos.find(v => v.id === videoId);
  if (!video) return;
  const ch = plannerState.channels.find(c => c.id === video.channelId);

  // Link the project to the idea's channel so its brand kit applies
  if (video.channelId) {
    state.channelId = video.channelId;
    populateProjectChannelSelect();
  }
  video.status = 'generating';
  savePlanner();
  setPlannerVisible(false);

  if (channelIsMusic(ch)) {
    // MUSIC channel: song-first flow — Setup has the Lyria song prompt AND the
    // character picker; scenes are storyboarded from the transcribed lyrics.
    state.pendingBrief = null; // briefs drive the explainer script agent only
    if (state.mode !== 'music') setProjectType('music');
    else goToStep(1);
    setInputValue('songPromptInput', buildSongPromptFromIdea(video, ch));
    scheduleProjectSave();
    showToast(`🎵 "${video.title}" loaded as a MUSIC video — generate the song, then pick your character.`, 'success');
    return;
  }

  // Non-music channel: explainer flow with the researched brief carried in
  state.pendingBrief = buildBrief(video);
  if (explainerTopicInput) explainerTopicInput.value = video.topic || video.videoPrompt || video.title;
  applyExplainerDuration(video.suggestedDurationSeconds);
  if (state.mode !== 'explainer') {
    setProjectType('explainer');
  } else {
    goToStep(1);
  }
  renderExplainerBrief();
  const n = state.pendingBrief ? state.pendingBrief.keyPoints.length : 0;
  showToast(`"${video.title}" loaded${n ? ` with ${n} key points` : ''}. Review the brief below, then generate.`, 'success');
}

// Channel opportunity finder: propose NEW channel concepts + platform from trends
async function suggestChannels() {
  const btn = document.getElementById('btnRunChannelSuggest');
  const grid = document.getElementById('channelSuggestGrid');
  const note = document.getElementById('channelSuggestNote');
  btn.disabled = true;
  btn.innerText = 'Researching niches...';

  try {
    const res = await fetch('/api/planner/suggest-channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interests: document.getElementById('channelInterestsInput').value.trim(),
        existingChannels: plannerState.channels.map(c => `${c.name} (${c.platform}: ${c.niche})`),
        useTrends: document.getElementById('chkUseTrends') ? document.getElementById('chkUseTrends').checked : true
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Channel suggestion failed');
    }

    const data = await res.json();
    renderChannelSuggestions(data);

    if (note) {
      const t = data.trendsUsed || {};
      const parts = [];
      if (t.googleTrends && t.googleTrends.length) parts.push(`Google Trends (${t.googleTrends.length})`);
      if (t.youtube && t.youtube.length) parts.push(`YouTube popular (${t.youtube.length})`);
      const trendStr = parts.length ? ` · Grounded on: ${parts.join(', ')}` : '';
      note.innerText = `${data.overallNote || ''}${trendStr}`;
      note.style.color = 'var(--color-info)';
      note.style.display = 'block';
    }
  } catch (error) {
    console.error(error);
    showToast(`Channel suggestion failed: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Find Channel Ideas';
  }
}

function renderChannelSuggestions(data) {
  const grid = document.getElementById('channelSuggestGrid');
  grid.innerHTML = '';
  lastChannelSuggestions = data.channels || [];

  lastChannelSuggestions.forEach((c, i) => {
    const platformBadge = c.platform === 'instagram' ? 'IG' : 'YT';
    const card = document.createElement('div');
    card.className = 'channel-suggest-card';
    card.innerHTML = `
      <div class="cs-head">
        <span class="cs-platform cs-${c.platform === 'instagram' ? 'ig' : 'yt'}">${platformBadge}</span>
        <span class="cs-name">${escapeHtml(c.channelName)}</span>
      </div>
      <div class="cs-niche">${escapeHtml(c.niche)}</div>
      <div class="cs-row"><strong>Why ${platformBadge}:</strong> ${escapeHtml(c.platformReason)}</div>
      <div class="cs-row"><strong>Opportunity:</strong> ${escapeHtml(c.whyViable)}</div>
      <div class="cs-row"><strong>Monetization:</strong> ${escapeHtml(c.monetization)}</div>
      <div class="cs-row"><strong>Pillars:</strong> ${(c.contentPillars || []).map(escapeHtml).join(' · ')}</div>
      <div class="cs-row cs-muted"><strong>Cadence:</strong> ${escapeHtml(c.postingCadence)}</div>
      <button class="btn btn-success btn-sm cs-create" data-idx="${i}">Create This Channel</button>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('.cs-create').forEach(b => {
    b.addEventListener('click', () => createSuggestedChannel(parseInt(b.dataset.idx, 10)));
  });
}

let lastChannelSuggestions = [];

function createSuggestedChannel(idx) {
  const c = lastChannelSuggestions[idx];
  if (!c) return;
  plannerState.channels.push({
    id: plannerId(),
    name: c.channelName,
    platform: c.platform === 'instagram' ? 'instagram' : 'youtube',
    niche: c.niche,
    subreddit: c.suggestedSubreddit || ''
  });
  savePlanner();
  renderPlanner();
  showToast(`Channel "${c.channelName}" created. Select it and hit "Suggest Viral Ideas" to plan videos.`, 'success');
}

// Small HTML escaper for injected suggestion text
function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------------- Real YouTube performance stats ---------------- */

function extractYouTubeId(url) {
  if (!url) return null;
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/);
  return m ? m[1] : null;
}

function formatCount(n) {
  if (n >= 1000000000) return (n / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

async function refreshPlannerStats() {
  const published = plannerState.videos
    .map(v => ({ v, ytId: extractYouTubeId(v.publishedUrl) }))
    .filter(x => x.ytId);

  if (published.length === 0) {
    showToast('No published videos with a YouTube URL yet. Set a video\'s status to Published and paste its URL.', 'warning');
    return;
  }

  const btn = document.getElementById('btnRefreshStats');
  btn.disabled = true;
  btn.innerText = 'Fetching…';

  try {
    const res = await fetch('/api/planner/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoIds: published.map(x => x.ytId) })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Stats fetch failed');
    }
    const data = await res.json();

    let updated = 0;
    published.forEach(({ v, ytId }) => {
      if (data.stats[ytId]) {
        v.stats = { ...data.stats[ytId], fetchedAt: Date.now() };
        updated++;
      }
    });

    savePlanner();
    renderPlanner();
    showToast(`Updated real stats for ${updated} published video${updated === 1 ? '' : 's'}.`, 'success');
  } catch (error) {
    console.error(error);
    showToast(`Stats refresh failed: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Refresh Stats';
  }
}

// Ask the viral topics agent for ideas for the selected channel
async function suggestPlannerIdeas() {
  const filter = document.getElementById('plannerChannelFilter');
  let channel = channelById(filter ? filter.value : '');
  if (!channel && plannerState.channels.length === 1) channel = plannerState.channels[0];
  if (!channel) {
    showToast('Select a channel first (or add one) so the agent knows the niche.', 'warning');
    return;
  }

  const btn = document.getElementById('btnSuggestIdeas');
  btn.disabled = true;
  btn.innerText = 'Agent researching ideas...';

  try {
    const res = await fetch('/api/planner/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelName: channel.name,
        platform: channel.platform,
        niche: channel.niche,
        count: 5,
        existingTitles: plannerState.videos.filter(v => v.channelId === channel.id).map(v => v.title),
        subreddit: channel.subreddit || '',
        useTrends: document.getElementById('chkUseTrends') ? document.getElementById('chkUseTrends').checked : false
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Suggestion failed');
    }

    const data = await res.json();
    (data.ideas || []).forEach(idea => {
      plannerState.videos.push({
        id: plannerId(),
        channelId: channel.id,
        title: idea.title,
        topic: idea.topic,
        format: ['long', 'short', 'reel'].includes(idea.format) ? idea.format : (channel.platform === 'instagram' ? 'reel' : 'long'),
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
          potential: ['high', 'medium', 'low'].includes((idea.roiPotential || '').toLowerCase())
            ? idea.roiPotential.toLowerCase() : 'medium',
          views: idea.roiEstimatedViews || '',
          revenue: idea.roiEstimatedRevenue || '',
          rationale: idea.roiRationale || ''
        },
        source: 'agent',
        createdAt: Date.now()
      });
    });

    const note = document.getElementById('plannerStrategyNote');
    if (note && data.strategyNote) {
      note.innerText = `Strategy note for ${channel.name}: ${data.strategyNote}`;
      note.style.display = 'block';
      note.style.color = 'var(--color-info)';
    }

    // Surface which live trend signals fed the agent (and any YouTube API caveat)
    const trendsNote = document.getElementById('trendsUsedNote');
    if (trendsNote) {
      const t = data.trendsUsed || {};
      const parts = [];
      if (t.googleTrends && t.googleTrends.length) parts.push(`Google Trends (${t.googleTrends.length})`);
      if (t.youtube && t.youtube.length) parts.push(`YouTube popular (${t.youtube.length})`);
      if (t.reddit && t.reddit.length) parts.push(`Reddit r/${(channel.subreddit || '').replace(/^\/?r\//, '')} (${t.reddit.length})`);
      if (parts.length) {
        trendsNote.innerText = `Live trend signals used: ${parts.join(' · ')}.${t.youtubeError ? ' Note: ' + t.youtubeError : ''}`;
        trendsNote.style.color = 'var(--color-success)';
        trendsNote.style.display = 'block';
      } else if (t.youtubeError) {
        trendsNote.innerText = t.youtubeError;
        trendsNote.style.color = 'var(--color-warning)';
        trendsNote.style.display = 'block';
      } else {
        trendsNote.style.display = 'none';
      }
    }

    savePlanner();
    renderPlanner();
    showToast(`Added ${(data.ideas || []).length} AI-suggested ideas for ${channel.name}. Hover a title for the hook & viral angle.`, 'success');
  } catch (error) {
    console.error(error);
    showToast(`Idea suggestion failed: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Suggest Viral Ideas (AI)';
  }
}

// Add the just-rendered Studio video to the planner as Ready
async function addRenderedVideoToPlanner() {
  if (!plannerState.loaded) await ensurePlannerLoaded();

  const title = (state.explainer && state.explainer.videoTitle)
    || (nleIntroTitle && nleIntroTitle.value)
    || 'Untitled AI video';

  plannerState.videos.push({
    id: plannerId(),
    channelId: plannerState.channels.length > 0 ? plannerState.channels[0].id : null,
    title: title,
    topic: state.explainer ? state.explainer.topic : '',
    format: 'long',
    status: 'ready',
    scheduledDate: '',
    source: 'studio',
    createdAt: Date.now()
  });

  savePlanner();
  renderPlanner();
  showToast(`"${title}" added to the planner as Ready. Open the Planner to schedule it.`, 'success');
}

// Planner UI wiring (script runs after DOM is parsed)
(function initPlanner() {
  const toggleBtn = document.getElementById('btnTogglePlanner');
  if (toggleBtn) toggleBtn.addEventListener('click', () => setPlannerVisible(!plannerState.visible));

  const filter = document.getElementById('plannerChannelFilter');
  if (filter) filter.addEventListener('change', () => { plannerPage = 1; renderPlanner(); });
  const statusFilterSel = document.getElementById('plannerStatusFilter');
  if (statusFilterSel) statusFilterSel.addEventListener('change', () => { plannerPage = 1; renderPlanner(); });
  const plannerSortSel = document.getElementById('plannerSort');
  if (plannerSortSel) plannerSortSel.addEventListener('change', () => { plannerPage = 1; renderPlanner(); });

  const btnAddChannel = document.getElementById('btnAddChannel');
  const channelForm = document.getElementById('channelForm');
  if (btnAddChannel && channelForm) {
    btnAddChannel.addEventListener('click', () => {
      channelForm.style.display = channelForm.style.display === 'none' ? 'flex' : 'none';
    });
    document.getElementById('btnCancelChannel').addEventListener('click', () => {
      channelForm.style.display = 'none';
    });
    document.getElementById('btnSaveChannel').addEventListener('click', () => {
      const name = document.getElementById('channelNameInput').value.trim();
      const niche = document.getElementById('channelNicheInput').value.trim();
      if (!name || !niche) {
        showToast('Channel name and niche are both required.', 'warning');
        return;
      }
      plannerState.channels.push({
        id: plannerId(),
        name: name,
        platform: document.getElementById('channelPlatformInput').value,
        niche: niche,
        contentType: document.getElementById('channelTypeInput') ? document.getElementById('channelTypeInput').value || null : null,
        subreddit: document.getElementById('channelSubredditInput').value.trim()
      });
      document.getElementById('channelNameInput').value = '';
      document.getElementById('channelNicheInput').value = '';
      document.getElementById('channelSubredditInput').value = '';
      channelForm.style.display = 'none';
      savePlanner();
      renderPlanner();
    });
  }

  const btnAddVideo = document.getElementById('btnAddVideoManual');
  const videoForm = document.getElementById('videoForm');
  if (btnAddVideo && videoForm) {
    btnAddVideo.addEventListener('click', () => {
      videoForm.style.display = videoForm.style.display === 'none' ? 'flex' : 'none';
    });
    document.getElementById('btnCancelVideo').addEventListener('click', () => {
      videoForm.style.display = 'none';
    });
    document.getElementById('btnSaveVideo').addEventListener('click', () => {
      const title = document.getElementById('videoTitleInput').value.trim();
      if (!title) {
        showToast('Video title is required.', 'warning');
        return;
      }
      plannerState.videos.push({
        id: plannerId(),
        channelId: document.getElementById('videoChannelInput').value || null,
        title: title,
        topic: '',
        format: document.getElementById('videoFormatInput').value,
        status: 'planned',
        scheduledDate: document.getElementById('videoDateInput').value || '',
        source: 'manual',
        createdAt: Date.now()
      });
      document.getElementById('videoTitleInput').value = '';
      videoForm.style.display = 'none';
      savePlanner();
      renderPlanner();
    });
  }

  const btnSuggest = document.getElementById('btnSuggestIdeas');
  if (btnSuggest) btnSuggest.addEventListener('click', suggestPlannerIdeas);

  const btnRefreshStats = document.getElementById('btnRefreshStats');
  if (btnRefreshStats) btnRefreshStats.addEventListener('click', refreshPlannerStats);

  // Channel opportunity finder
  const btnSuggestChannel = document.getElementById('btnSuggestChannel');
  const channelSuggestBox = document.getElementById('channelSuggestBox');
  if (btnSuggestChannel && channelSuggestBox) {
    btnSuggestChannel.addEventListener('click', () => {
      channelSuggestBox.style.display = channelSuggestBox.style.display === 'none' ? 'block' : 'none';
    });
  }
  const btnCloseChannelSuggest = document.getElementById('btnCloseChannelSuggest');
  if (btnCloseChannelSuggest) btnCloseChannelSuggest.addEventListener('click', () => {
    channelSuggestBox.style.display = 'none';
  });
  const btnRunChannelSuggest = document.getElementById('btnRunChannelSuggest');
  if (btnRunChannelSuggest) btnRunChannelSuggest.addEventListener('click', suggestChannels);

  // Trend Watch controls
  const twEnabled = document.getElementById('twEnabled');
  const twInterval = document.getElementById('twInterval');
  const btnTwRunNow = document.getElementById('btnTwRunNow');
  if (twEnabled) twEnabled.addEventListener('change', saveTrendWatchSettings);
  if (twInterval) twInterval.addEventListener('change', () => {
    if (twEnabled && twEnabled.checked) saveTrendWatchSettings();
  });
  if (btnTwRunNow) btnTwRunNow.addEventListener('click', runTrendWatchNow);

  const btnScanRadar = document.getElementById('btnScanRadar');
  if (btnScanRadar) btnScanRadar.addEventListener('click', scanViralRadar);

  const btnAddToPlanner = document.getElementById('btnAddToPlanner');
  if (btnAddToPlanner) btnAddToPlanner.addEventListener('click', addRenderedVideoToPlanner);
})();

// Scan Multi-Source Viral Trend Radar
async function scanViralRadar() {
  const btn = document.getElementById('btnScanRadar');
  const resultsContainer = document.getElementById('radarResultsContainer');
  const summaryAlert = document.getElementById('radarSummaryAlert');
  const grid = document.getElementById('radarTopicsGrid');

  if (!btn || !resultsContainer || !grid) return;

  const subredditsRaw = document.getElementById('radarSubredditsInput')?.value || 'AskReddit, explainlikeimfive, todayilearned';
  const newsQuery = document.getElementById('radarNewsQueryInput')?.value || 'technology';
  const subreddits = subredditsRaw.split(',').map(s => s.trim()).filter(Boolean);

  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner"></span> Scanning Live Signals...`;

  try {
    const res = await fetch('/api/planner/trends-radar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subreddits, newsQuery, geo: 'US' })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to scan trend radar");
    }

    const data = await res.json();
    const fusion = data.fusion;

    resultsContainer.style.display = 'block';

    if (summaryAlert && fusion?.crossPlatformSummary) {
      summaryAlert.innerText = `⚡ Signal Convergence: ${fusion.crossPlatformSummary}`;
    }

    grid.innerHTML = '';

    const topics = fusion?.topics || [];
    topics.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'radar-topic-card';

      const sourcesHtml = (t.sources || []).map(s => {
        let cls = 'googletrends';
        if (s.toLowerCase().includes('reddit')) cls = 'reddit';
        if (s.toLowerCase().includes('hacker')) cls = 'hackernews';
        if (s.toLowerCase().includes('wiki')) cls = 'wikipedia';
        if (s.toLowerCase().includes('news')) cls = 'googlenews';
        return `<span class="provenance-tag ${cls}">${s}</span>`;
      }).join(' ');

      const keyPoints = (t.keyPoints || []).filter(Boolean);
      const keyPointsHtml = keyPoints.length ? `
        <details class="radar-brief">
          <summary>Content brief · ${keyPoints.length} key points${t.suggestedDurationSeconds ? ` · ~${t.suggestedDurationSeconds}s` : ''}</summary>
          ${t.angle ? `<div class="rb-line"><strong>Angle:</strong> ${escapeHtml(t.angle)}</div>` : ''}
          ${t.targetAudience ? `<div class="rb-line"><strong>For:</strong> ${escapeHtml(t.targetAudience)}</div>` : ''}
          <ul class="rb-points">${keyPoints.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        </details>` : '';

      card.innerHTML = `
        <div class="radar-card-header">
          <div class="radar-card-title">${escapeHtml(t.title)}</div>
          <span class="viral-score-badge">🔥 Score ${t.viralScore}/100</span>
        </div>
        <p style="font-size: 0.82rem; color: var(--color-text-muted); margin: 0;">${escapeHtml(t.topic)}</p>
        <div style="display: flex; flex-wrap: wrap; gap: 0.3rem; margin: 0.3rem 0;">${sourcesHtml}</div>
        <div style="font-size: 0.8rem; background: rgba(255,255,255,0.03); padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
          <strong>Hook:</strong> "${escapeHtml(t.hook || '')}"
        </div>
        ${keyPointsHtml}
        <div class="radar-card-actions">
          <button class="btn btn-secondary btn-sm btn-plan-from-trend">Add to Planner</button>
          <button class="btn btn-primary btn-sm btn-create-from-trend">⚡ Create Video</button>
        </div>
      `;

      card.querySelector('.btn-create-from-trend').addEventListener('click', () => loadTrendIntoStudio(t));
      card.querySelector('.btn-plan-from-trend').addEventListener('click', (e) => {
        addTrendTopicToPlanner(t);
        e.target.disabled = true;
        e.target.innerText = 'Added ✓';
      });

      grid.appendChild(card);
    });

    showToast("Viral Trend Radar scan complete!", "success");
  } catch (error) {
    console.error(error);
    showToast(`Radar scan failed: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `📡 Scan Live Trend Radar`;
  }
}

