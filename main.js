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

let currentVideoBlob = null;
let isApprovedForPublish = false;

// Filled at runtime from Tenor
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

async function renderScriptToVideo(title, lines) {
  const width = 720;
  const height = 1280;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const ttsBase = window.location.origin.includes(':5173') ? 'http://localhost:3001' : '';
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

  // 2) Background (Tenor GIF or fallback video)
  const source =
    bgVideosCache.length
      ? bgVideosCache
      : ['https://sample-videos.com/video321/mp4/720/big_buck_bunny_720p_1mb.mp4'];
  const mp4s = source.filter((u) => String(u).toLowerCase().includes('.mp4'));
  const pool = mp4s.length ? mp4s : source;
  const bgUrl = pool[Math.floor(Math.random() * pool.length)];

  const isGif = bgUrl.toLowerCase().includes('.gif');
  const bgVideo = isGif ? null : document.createElement('video');
  const bgImage = isGif ? new Image() : null;

  if (isGif) {
    bgImage.crossOrigin = 'anonymous';
    bgImage.src = bgUrl;
    await new Promise((resolve, reject) => {
      bgImage.onload = () => resolve();
      bgImage.onerror = () => reject(new Error('Failed to load GIF background'));
    }).catch(() => {});
    // GIF only animates when the img is in the DOM; hide it off-screen
    bgImage.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(bgImage);
  } else {
    bgVideo.src = bgUrl;
    bgVideo.loop = true;
    bgVideo.muted = true;
    bgVideo.crossOrigin = 'anonymous';
    await bgVideo.play().catch(() => {});
  }

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
      if (isGif && bgImage) {
        ctx.drawImage(bgImage, 0, 0, width, height);
      } else if (bgVideo) {
        ctx.drawImage(bgVideo, 0, 0, width, height);
      }
    } catch {}

    const grd = ctx.createLinearGradient(0, height * 0.5, 0, height);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, width, height);

    drawTitleWithBox(ctx, title, width, height);

    const idx = getSegmentIndex(elapsed);
    const current = segmentTexts[idx] ?? '';
    drawSubtitleWithBox(ctx, current, width, height);

    if (elapsed < totalDurationMs) {
      requestAnimationFrame(drawFrame);
    } else {
      recorder.stop();
      mixedStream.getTracks().forEach((t) => t.stop());
      if (isGif && bgImage && bgImage.parentNode) bgImage.remove();
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

function getWrappedLines(ctx, text, maxWidth) {
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
  return lines;
}

function drawTitleWithBox(ctx, title, width, height) {
  const maxW = width * 0.88;
  const pad = 24;
  const lineHeight = 58;
  ctx.font = 'bold 52px system-ui';
  const titleStr = title.slice(0, 120);
  const lines = getWrappedLines(ctx, titleStr, maxW);
  let boxW = 0;
  lines.forEach((l) => {
    const w = ctx.measureText(l).width;
    if (w > boxW) boxW = w;
  });
  boxW += pad * 2;
  const boxH = lines.length * lineHeight + 20;
  const centerY = height * 0.25;
  const boxX = (width - boxW) / 2;
  const boxY = centerY - boxH / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 12);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => {
    ctx.fillText(l.trim(), width / 2, startY + i * lineHeight);
  });
}

function drawSubtitleWithBox(ctx, text, width, height) {
  const maxW = width * 0.88;
  const pad = 28;
  const lineHeight = 42;
  ctx.font = '36px system-ui';
  const str = text.slice(0, 300);
  const lines = getWrappedLines(ctx, str, maxW);
  if (!lines.length) return;
  let boxW = 0;
  lines.forEach((l) => {
    const w = ctx.measureText(l).width;
    if (w > boxW) boxW = w;
  });
  boxW += pad * 2;
  const boxH = lines.length * lineHeight + 24;
  const centerY = height * 0.8;
  const boxX = (width - boxW) / 2;
  const boxY = centerY - boxH / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 12);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => {
    ctx.fillText(l.trim(), width / 2, startY + i * lineHeight);
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

  if (!bgVideosCache.length) {
    previewPlaceholder.textContent = 'Fetching GIFs…';
    await fetchBackgroundGifs(12);
  }

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

    previewPlaceholder.textContent = 'Rendering video… (may take a bit)';
    currentVideoBlob = await renderScriptToVideo(data.title, data.lines);

    previewVideo.src = URL.createObjectURL(currentVideoBlob);
    previewVideo.classList.remove('hidden');
    previewPlaceholder.classList.add('hidden');
    isApprovedForPublish = false;
    if (btnApprove) btnApprove.disabled = false;
    if (btnPublish) btnPublish.disabled = true;
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
  showMessage('Video approved. Now you can publish it to YouTube.', 'success');
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

btnVideo.addEventListener('click', generateVideo);
btnConnectYt.addEventListener('click', openYoutubeAuth);
if (btnApprove) btnApprove.addEventListener('click', approveVideo);
btnPublish.addEventListener('click', publishToYouTube);

// Delay first API call so backend has time to start when using npm run dev
setTimeout(checkYoutubeStatus, 1500);

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
