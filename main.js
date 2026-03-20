const promptEl = document.getElementById('prompt');
const btnVideo = document.getElementById('btn-video');
const messageEl = document.getElementById('message');
const previewPlaceholder = document.getElementById('preview-placeholder');
const previewVideo = document.getElementById('preview-video');
const youtubeStatus = document.getElementById('youtube-status');
const btnConnectYt = document.getElementById('btn-connect-yt');
const publishForm = document.getElementById('publish-form');
const ytTitle = document.getElementById('yt-title');
const ytDesc = document.getElementById('yt-desc');
const ytPrivacy = document.getElementById('yt-privacy');
const btnApprove = document.getElementById('btn-approve');
const btnPublish = document.getElementById('btn-publish');
const tiktokStatus = document.getElementById('tiktok-status');
const btnConnectTiktok = document.getElementById('btn-connect-tiktok');
const tiktokForm = document.getElementById('tiktok-form');
const tiktokCaption = document.getElementById('tiktok-caption');
const btnApproveTiktok = document.getElementById('btn-approve-tiktok');
const btnPublishTiktok = document.getElementById('btn-publish-tiktok');

let currentVideoBlob = null;
let isApprovedForPublish = false;

// Legacy GIF/video background code (kept for later use).
// Current pipeline uses AI-generated images instead (see `/api/generate-images`).
let bgVideosCache = [];

function showMessage(text, type = 'info') {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  messageEl.classList.remove('hidden');
}

function hideMessage() {
  messageEl.classList.add('hidden');
}

function setLoading(button, loading) {
  button.disabled = loading;
  button.textContent = loading ? '…' : button.dataset.label || button.textContent;
}

async function fetchBackgroundGifs(limit = 10) {
  try {
    const res = await fetch(`/api/gifs?limit=${limit}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Background provider error: ${res.status}`);
    if (!Array.isArray(data.gifs) || !data.gifs.length) throw new Error('No GIFs returned');
    bgVideosCache = data.gifs;
  } catch (e) {
    console.error(e);
  }
}

async function fetchAiBackgroundImages(title, lines, maxImages = 8) {
  const res = await fetch('/api/generate-images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, lines, maxImages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.details || `AI image generation failed: ${res.status}`);
  if (!Array.isArray(data.images) || !data.images.length) throw new Error('No AI images returned');
  return data;
}

const TTS_CONCURRENCY = 3;

async function fetchTtsSegment(ttsBase, text) {
  const res = await fetch(`${ttsBase}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.trim() }),
  });
  if (!res.ok) return null;
  return res.blob();
}

async function fetchAllTtsSegments(ttsBase, texts) {
  const out = [];
  let i = 0;
  while (i < texts.length) {
    const batch = texts.slice(i, i + TTS_CONCURRENCY);
    const results = await Promise.all(batch.map((text) => fetchTtsSegment(ttsBase, text)));
    out.push(...results);
    i += TTS_CONCURRENCY;
  }
  return out;
}

async function buildSyncedAudioStream(segments, blobs) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffers = [];
  for (let i = 0; i < blobs.length; i++) {
    if (!blobs[i]) continue;
    const arrayBuffer = await blobs[i].arrayBuffer();
    const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    buffers.push({ buffer: buf, text: segments[i] });
  }
  if (!buffers.length) return { stream: null, startTimesMs: [], totalDurationMs: 0, segmentTexts: [] };

  const durations = buffers.map((b) => b.buffer.duration * 1000);
  const startTimesMs = [0];
  for (let j = 0; j < durations.length - 1; j++) {
    startTimesMs.push(startTimesMs[startTimesMs.length - 1] + durations[j]);
  }
  const totalDurationMs = startTimesMs[startTimesMs.length - 1] + (durations[durations.length - 1] || 0);
  const segmentTexts = buffers.map((b) => b.text);

  const sampleRate = buffers[0].buffer.sampleRate;
  const numChannels = Math.min(2, buffers[0].buffer.numberOfChannels);
  const totalSamples = Math.ceil((totalDurationMs / 1000) * sampleRate);
  const offline = new OfflineAudioContext(numChannels, totalSamples, sampleRate);
  let currentTime = 0;
  for (const { buffer } of buffers) {
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start(currentTime, 0, buffer.duration);
    currentTime += buffer.duration;
  }
  const rendered = await offline.startRendering();
  const playCtx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = playCtx.createMediaStreamDestination();
  const src = playCtx.createBufferSource();
  src.buffer = rendered;
  src.connect(dest);
  const startPlayback = () => {
    try {
      src.start(0);
    } catch (_) {}
  };
  return { stream: dest.stream, startTimesMs, totalDurationMs, segmentTexts, startPlayback };
}

async function renderScriptToVideo(title, lines, bgGen) {
  const width = 720;
  const height = 1280;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Use relative `/api/tts`; Vite dev server will proxy it to backend,
  // and in production backend serves the same origin.
  const ttsBase = '';
  const segments = [title, ...lines];
  let audioStream = null;
  let startPlayback = null;
  let startTimesMs = [];
  let totalDurationMs = 0;
  let segmentTexts = [];

  try {
    const blobs = await fetchAllTtsSegments(ttsBase, segments);
    const ok = blobs.filter(Boolean).length;
    if (ok === segments.length) {
      const synced = await buildSyncedAudioStream(segments, blobs);
      audioStream = synced.stream;
      startPlayback = synced.startPlayback;
      startTimesMs = synced.startTimesMs;
      totalDurationMs = synced.totalDurationMs;
      segmentTexts = synced.segmentTexts;
    }
    if (!audioStream) {
      const fallback = [segments.join('. ')];
      const fallbackBlobs = await fetchAllTtsSegments(ttsBase, fallback);
      if (fallbackBlobs[0]) {
        const single = await buildSyncedAudioStream(fallback, fallbackBlobs);
        if (single.stream) {
          audioStream = single.stream;
          startPlayback = single.startPlayback;
          const fixed = 6000;
          const fallbackDuration = (1 + lines.length) * fixed;
          totalDurationMs = Math.max(single.totalDurationMs, fallbackDuration);
          startTimesMs = [0, ...lines.map((_, i) => (i + 1) * fixed)];
          segmentTexts = [title, ...lines];
        }
      }
    }
  } catch (e) {
    console.warn('TTS skipped, video will be mute', e);
  }

  if (!totalDurationMs && segmentTexts.length) {
    const fixed = 6000;
    totalDurationMs = segmentTexts.length * fixed;
    startTimesMs = segmentTexts.map((_, i) => i * fixed);
  } else if (!totalDurationMs) {
    totalDurationMs = Math.max(1, lines.length) * 6000;
    startTimesMs = lines.map((_, i) => (i + 1) * 6000);
    startTimesMs.unshift(0);
    segmentTexts = [title, ...lines];
  }

  // 2) Background: AI-generated images (sequence matched to subtitle timing)
  const bgImageDataUrls = Array.isArray(bgGen?.images) ? bgGen.images : [];
  const selectedSegmentIndexes = Array.isArray(bgGen?.selectedSegmentIndexes) ? bgGen.selectedSegmentIndexes : [];

  const bgImages = [];
  for (const dataUrl of bgImageDataUrls) {
    const img = new Image();
    img.src = dataUrl;
    try {
      // decode() doesn't throw for some dataURL types; keep it best-effort.
      // eslint-disable-next-line no-await-in-loop
      await img.decode();
    } catch (_) {}
    bgImages.push(img);
  }

  function buildSegmentToImageIndex(segmentCount, selected) {
    if (!bgImages.length || !Array.isArray(selected) || !selected.length) return new Array(segmentCount).fill(0);
    const map = new Array(segmentCount).fill(0);
    let last = 0;
    for (let seg = 0; seg < segmentCount; seg++) {
      while (last + 1 < selected.length && selected[last + 1] <= seg) last++;
      map[seg] = Math.min(last, bgImages.length - 1);
    }
    return map;
  }

  const segmentToImageIndex = buildSegmentToImageIndex(segmentTexts.length, selectedSegmentIndexes);

  // 3) Merge canvas (video) + TTS (audio) for recording
  const canvasStream = canvas.captureStream(30);
  const tracks = [...canvasStream.getVideoTracks()];
  if (audioStream) {
    const audioTracks = audioStream.getAudioTracks();
    if (audioTracks.length) tracks.push(...audioTracks);
  }
  const mixedStream = new MediaStream(tracks);

  const wantAudio = tracks.some((t) => t.kind === 'audio');
  const mimeOpts = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].filter((m) => MediaRecorder.isTypeSupported(m));
  const mimeType = wantAudio && mimeOpts.length ? mimeOpts[0] : 'video/webm;codecs=vp9';

  const recorder = new MediaRecorder(mixedStream, {
    mimeType,
    videoBitsPerSecond: 2500000,
    audioBitsPerSecond: 128000,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  let startTime = null;

  function getSegmentIndex(elapsedMs) {
    if (!startTimesMs.length || elapsedMs < startTimesMs[0]) return 0;
    for (let i = startTimesMs.length - 1; i >= 0; i--) {
      if (elapsedMs >= startTimesMs[i]) return i;
    }
    return 0;
  }

  function drawFrame(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    try {
      if (bgImages.length) {
        const idx = getSegmentIndex(elapsed);
        const imgIdx = segmentToImageIndex[idx] ?? 0;
        const bgImg = bgImages[imgIdx];
        if (bgImg) ctx.drawImage(bgImg, 0, 0, width, height);
      }
    } catch {}

    const grd = ctx.createLinearGradient(0, height * 0.5, 0, height);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const titleStr = title.slice(0, 80);
    ctx.font = 'bold 56px system-ui';
    const titleW = ctx.measureText(titleStr).width;
    const titleH = 64;
    const pad = 24;
    const boxX = (width - titleW - pad * 2) / 2;
    const boxY = height * 0.25 - titleH / 2 - 8;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, titleW + pad * 2, titleH + 16, 12);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 56px system-ui';
    ctx.fillText(titleStr, width / 2, height * 0.25);

    const idx = getSegmentIndex(elapsed);
    const current = segmentTexts[idx] ?? '';
    ctx.font = '28px system-ui';
    wrapText(ctx, current.slice(0, 200), width / 2, height * 0.8, width * 0.8, 32);

    if (elapsed < totalDurationMs) {
      requestAnimationFrame(drawFrame);
    } else {
      recorder.stop();
      mixedStream.getTracks().forEach((t) => t.stop());
    }
  }

  recorder.start(200);
  if (startPlayback) startPlayback();
  requestAnimationFrame(drawFrame);

  return new Promise((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      resolve(blob);
    };
  });
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  const lines = [];
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      lines.push(line);
      line = words[n] + ' ';
    } else {
      line = testLine;
    }
  }
  lines.push(line);
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => {
    ctx.fillText(l, x, startY + i * lineHeight);
  });
}

async function generateVideo() {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    showMessage('Enter a prompt first.', 'error');
    return;
  }
  btnVideo.dataset.label = 'Generate video';
  setLoading(btnVideo, true);
  hideMessage();
  previewVideo.classList.add('hidden');
  previewPlaceholder.classList.remove('hidden');
  previewPlaceholder.textContent = 'Generating script…';

  try {
    const res = await fetch('/api/generate-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
    if (!data.title || !Array.isArray(data.lines) || !data.lines.length) {
      throw new Error('Script is empty. Try another prompt.');
    }

    previewPlaceholder.textContent = 'Generating AI background images…';
    // Generate more scene-matched images for better story continuity.
    const desiredImages = Math.min(Math.max(data.lines.length + 1, 6), 12);
    const bgGen = await fetchAiBackgroundImages(data.title, data.lines, desiredImages);
    previewPlaceholder.textContent = 'Rendering video… (may take a bit)';
    currentVideoBlob = await renderScriptToVideo(data.title, data.lines, bgGen);

    previewVideo.src = URL.createObjectURL(currentVideoBlob);
    previewVideo.classList.remove('hidden');
    previewPlaceholder.classList.add('hidden');
    isApprovedForPublish = false;
    if (btnApprove) btnApprove.disabled = false;
    if (btnPublish) btnPublish.disabled = true;
    if (btnApproveTiktok) btnApproveTiktok.disabled = false;
    if (btnPublishTiktok) btnPublishTiktok.disabled = true;
    showMessage('Video ready. Review it, then click "Approve video" before publishing.', 'success');
  } catch (e) {
    showMessage(e.message || 'Video generation failed', 'error');
    previewPlaceholder.textContent = 'Your video will appear here.';
  } finally {
    setLoading(btnVideo, false);
  }
}

async function checkYoutubeStatus(retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('/api/youtube/status');
      const data = await res.json();
      if (data.connected) {
        youtubeStatus.textContent = 'Connected to YouTube';
        youtubeStatus.className = 'youtube-status connected';
        publishForm.classList.remove('hidden');
      } else {
        youtubeStatus.textContent = data.reason === 'not_configured' ? 'YouTube not configured (see .env)' : 'Not connected';
        youtubeStatus.className = 'youtube-status disconnected';
        publishForm.classList.add('hidden');
      }
      return;
    } catch {
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1200));
      else {
        youtubeStatus.textContent = 'Could not reach server (refresh in a moment)';
        youtubeStatus.className = 'youtube-status disconnected';
      }
    }
  }
}

async function openYoutubeAuth() {
  try {
    const res = await fetch('/api/youtube/auth-url');
    const data = await res.json();
    if (data.url) window.open(data.url, '_blank', 'width=500,height=600');
    else showMessage(data.error || 'No auth URL', 'error');
  } catch (e) {
    showMessage('Failed to get auth URL', 'error');
  }
}

function approveVideo() {
  if (!currentVideoBlob) {
    showMessage('Generate a video and watch it first.', 'error');
    return;
  }
  isApprovedForPublish = true;
  if (btnApprove) btnApprove.disabled = true;
  if (btnPublish) btnPublish.disabled = false;
  if (btnApproveTiktok) btnApproveTiktok.disabled = true;
  if (btnPublishTiktok) btnPublishTiktok.disabled = false;
  showMessage('Video approved. You can publish to YouTube or TikTok.', 'success');
}

async function publishToYouTube() {
  if (!currentVideoBlob) {
    showMessage('Generate a video first.', 'error');
    return;
  }
  if (!isApprovedForPublish) {
    showMessage('Please click "Approve video" after reviewing the video, before publishing.', 'error');
    return;
  }
  btnPublish.dataset.label = 'Publish to YouTube';
  setLoading(btnPublish, true);
  hideMessage();
  const form = new FormData();
  const ext = currentVideoBlob.type.includes('webm') ? 'webm' : 'mp4';
  form.append('video', currentVideoBlob, `video.${ext}`);
  form.append('title', ytTitle.value.trim() || 'Generated Video');
  form.append('description', ytDesc.value.trim() || '');
  form.append('privacy', ytPrivacy.value);

  try {
    const res = await fetch('/api/youtube/upload', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.details || 'Upload failed');
    showMessage(`Published! ${data.url ? `Video: ${data.url}` : ''}`, 'success');
    if (data.url) window.open(data.url, '_blank');
  } catch (e) {
    showMessage(e.message || 'Upload failed', 'error');
  } finally {
    setLoading(btnPublish, false);
  }
}

async function checkTiktokStatus(retries = 6) {
  const apiBase = window.location.origin.includes(':5173') ? 'http://localhost:3001' : '';
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${apiBase}/api/tiktok/status`);
      const data = await res.json();
      if (data.connected) {
        tiktokStatus.textContent = 'Connected to TikTok';
        tiktokStatus.className = 'youtube-status connected';
        tiktokForm.classList.remove('hidden');
      } else {
        tiktokStatus.textContent = data.reason === 'not_configured' ? 'TikTok not configured (see .env)' : 'Not connected';
        tiktokStatus.className = 'youtube-status disconnected';
        tiktokForm.classList.add('hidden');
      }
      return;
    } catch {
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1200));
      else {
        tiktokStatus.textContent = 'Could not reach server (refresh in a moment)';
        tiktokStatus.className = 'youtube-status disconnected';
      }
    }
  }
}

async function openTiktokAuth() {
  const apiBase = window.location.origin.includes(':5173') ? 'http://localhost:3001' : '';
  try {
    const res = await fetch(`${apiBase}/api/tiktok/auth-url`);
    const data = await res.json().catch(() => ({}));
    if (data.url) window.open(data.url, '_blank', 'width=500,height=600');
    else showMessage(data.error || 'No auth URL', 'error');
  } catch (e) {
    showMessage('Failed to get TikTok auth URL. Is the server running on port 3001?', 'error');
  }
}

async function publishToTikTok() {
  if (!currentVideoBlob) {
    showMessage('Generate a video first.', 'error');
    return;
  }
  if (!isApprovedForPublish) {
    showMessage('Please click "Approve video" after reviewing the video, before publishing.', 'error');
    return;
  }
  const apiBase = window.location.origin.includes(':5173') ? 'http://localhost:3001' : '';
  const statusRes = await fetch(`${apiBase}/api/tiktok/status`);
  const statusData = await statusRes.json().catch(() => ({}));
  if (!statusData.connected) {
    showMessage('Connect TikTok first, then try Publish again.', 'info');
    openTiktokAuth();
    return;
  }
  if (!btnPublishTiktok) return;
  btnPublishTiktok.dataset.label = 'Publish to TikTok';
  setLoading(btnPublishTiktok, true);
  hideMessage();
  const form = new FormData();
  const ext = currentVideoBlob.type.includes('webm') ? 'webm' : 'mp4';
  form.append('video', currentVideoBlob, `video.${ext}`);
  form.append('caption', tiktokCaption ? tiktokCaption.value.trim() : '');

  try {
    const res = await fetch(`${apiBase}/api/tiktok/upload`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.details || 'Upload failed');
    showMessage(data.message || 'Sent to TikTok!', 'success');
  } catch (e) {
    showMessage(e.message || 'TikTok upload failed', 'error');
  } finally {
    setLoading(btnPublishTiktok, false);
  }
}

btnVideo.addEventListener('click', generateVideo);
btnConnectYt.addEventListener('click', openYoutubeAuth);
if (btnApprove) btnApprove.addEventListener('click', approveVideo);
btnPublish.addEventListener('click', publishToYouTube);
if (btnConnectTiktok) btnConnectTiktok.addEventListener('click', openTiktokAuth);
if (btnApproveTiktok) btnApproveTiktok.addEventListener('click', approveVideo);
if (btnPublishTiktok) btnPublishTiktok.addEventListener('click', publishToTikTok);

// Delay first API call so backend has time to start when using npm run dev
setTimeout(checkYoutubeStatus, 1500);
setTimeout(checkTiktokStatus, 1500);

const params = new URLSearchParams(location.search);
if (params.get('youtube') === 'connected') {
  showMessage('YouTube connected. You can publish your video.', 'success');
  history.replaceState({}, '', location.pathname);
  checkYoutubeStatus();
}
if (params.get('youtube') === 'error') {
  showMessage('YouTube connection failed. Try again.', 'error');
  history.replaceState({}, '', location.pathname);
}
if (params.get('tiktok') === 'connected') {
  showMessage('TikTok connected. You can publish your video.', 'success');
  history.replaceState({}, '', location.pathname);
  checkTiktokStatus();
}
if (params.get('tiktok') === 'error') {
  showMessage('TikTok connection failed. Try again.', 'error');
  history.replaceState({}, '', location.pathname);
}
