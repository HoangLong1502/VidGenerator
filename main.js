const promptEl = document.getElementById('prompt');
const btnVideo = document.getElementById('btn-video');
const messageEl = document.getElementById('message');
const tokenUsageEl = document.getElementById('token-usage');
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

function formatTokenUsage(usageData) {
  const usage = usageData?.usage;
  if (!usage || typeof usage !== 'object') return '';

  const promptTokens = Number(usage.promptTokens || 0);
  const outputTokens = Number(usage.candidatesTokens || 0);
  const thoughtsTokens = Number(usage.thoughtsTokens || 0);
  const totalTokens = Number(usage.totalTokens || promptTokens + outputTokens + thoughtsTokens);
  const modelName = usageData?.modelUsed || 'unknown';

  return `Token usage (${modelName}) - total: ${totalTokens} | prompt: ${promptTokens} | output: ${outputTokens} | thoughts: ${thoughtsTokens}`;
}

function setTokenUsage(usageData) {
  if (!tokenUsageEl) return;
  const text = formatTokenUsage(usageData);
  if (!text) {
    tokenUsageEl.textContent = '';
    tokenUsageEl.classList.add('hidden');
    return;
  }
  tokenUsageEl.textContent = text;
  tokenUsageEl.classList.remove('hidden');
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

/**
 * Decode a data URL into something drawImage accepts. Safari/WebKit sometimes fails img.decode()
 * on large base64; ImageBitmap from Blob is more reliable.
 */
async function loadDataUrlAsDrawable(dataUrl) {
  const s = String(dataUrl || '');
  if (!s.startsWith('data:')) return null;

  const tryImg = () =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth >= 2 && img.naturalHeight >= 2) resolve(img);
        else reject(new Error('zero-size image'));
      };
      img.onerror = () => reject(new Error('Image.onerror'));
      img.src = s;
    });

  try {
    const img = await tryImg();
    if (typeof img.decode === 'function') {
      try {
        await img.decode();
      } catch (_) {
        /* decode optional */
      }
    }
    return img;
  } catch (e1) {
    try {
      const res = await fetch(s);
      const blob = await res.blob();
      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(blob);
        if (bmp.width >= 2 && bmp.height >= 2) return bmp;
      }
    } catch (e2) {
      console.warn('[video] Could not load background image', e1?.message || e1, e2?.message || e2);
    }
  }
  return null;
}

async function fetchAiBackgroundImages(title, lines, maxImages = 16) {
  async function requestImages(requestCount) {
    const res = await fetch('/api/generate-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, lines, maxImages: requestCount }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.details || `AI image generation failed: ${res.status}`);
    if (!Array.isArray(data.images) || !data.images.length) throw new Error('No AI images returned');
    return data;
  }

  try {
    return await requestImages(maxImages);
  } catch (e) {
    const msg = String(e?.message || '');
    const retryable =
      /empty_response|fetch|timeout|network|502|503|504/i.test(msg);
    if (!retryable) throw e;

    const reduced = Math.max(3, Math.floor(maxImages / 2));
    if (reduced >= maxImages) throw e;
    showMessage(`Image API unstable, retrying with ${reduced} images...`, 'info');
    return requestImages(reduced);
  }
}

const TTS_CONCURRENCY = 1;
const TTS_MAX_RETRIES = 4;
const TTS_RETRY_DELAY_MS = 500;
// Must match Edge neural id; sent explicitly so TTS is female even if server .env is wrong.
const _envTtsVoice = import.meta.env.VITE_TTS_VOICE;
const TTS_EDGE_VOICE =
  (typeof _envTtsVoice === 'string' && _envTtsVoice.trim()) || 'vi-VN-HoaiMyNeural';

async function fetchTtsSegment(ttsBase, text) {
  const payload = JSON.stringify({ text: text.trim(), voice: TTS_EDGE_VOICE });
  for (let attempt = 0; attempt <= TTS_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${ttsBase}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (res.ok) {
        const blob = await res.blob();
        if (blob && blob.size > 0) return blob;
      }

      const emptyOk = res.ok;
      const retryable =
        emptyOk ||
        (!res.ok &&
          (res.status === 500 ||
            res.status === 502 ||
            res.status === 503 ||
            res.status === 504 ||
            res.status === 429 ||
            res.status === 408));
      if (attempt < TTS_MAX_RETRIES && retryable) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, TTS_RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      return null;
    } catch (_) {
      if (attempt < TTS_MAX_RETRIES) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, TTS_RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Multi-pass fetch so a single failed chunk does not drop part of the narration. */
async function fetchTtsBlobsRobust(ttsBase, chunks, rounds = 6) {
  let blobs = await fetchAllTtsSegments(ttsBase, chunks);
  for (let round = 0; round < rounds; round++) {
    let anyMissing = false;
    for (let i = 0; i < blobs.length; i++) {
      if (!blobs[i] || blobs[i].size === 0) {
        anyMissing = true;
        // eslint-disable-next-line no-await-in-loop
        blobs[i] = await fetchTtsSegment(ttsBase, chunks[i]);
      }
    }
    if (!anyMissing) break;
  }
  return blobs;
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

const TTS_MIX_SAMPLE_RATE = 48000;
const TTS_MIN_SEGMENT_SEC = 0.08;
/** Crossfade between TTS clips to hide MP3 edge clicks / hard cuts (ms). */
const TTS_CROSSFADE_MS = 48;
/**
 * Edge / Microsoft TTS ~4096 UTF-8 bytes per request; staying well under avoids truncated MP3
 * (speech stops mid-clause even though the request "succeeds").
 */
const TTS_MAX_CHUNK_BYTES = 2000;
const _ttsUtf8 = new TextEncoder();

function utf8ByteLength(s) {
  return _ttsUtf8.encode(s).length;
}

/** Split one line into chunks under the byte cap; prefers sentence/clause boundaries, then hard UTF-8 splits. */
function splitStringToTtsChunks(text, maxBytes) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return [];
  if (utf8ByteLength(t) <= maxBytes) return [t];

  // Prefer full sentences; only then clauses (comma); avoid tiny fragments.
  const rough = t.split(/(?<=[.!?…。])\s+/u).filter(Boolean);
  const mid = rough.length > 1 ? rough : t.split(/(?<=[,;:，；])\s+/u).filter(Boolean);
  const pieces =
    mid.length > 1
      ? mid
      : rough.length === 1 && utf8ByteLength(rough[0]) > maxBytes
        ? rough
        : t.split(/\s+/u).filter(Boolean);
  const words = pieces;

  const out = [];
  let buf = '';
  const flushBuf = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };

  for (const p of words) {
    const cand = buf ? `${buf} ${p}` : p;
    if (utf8ByteLength(cand) <= maxBytes) {
      buf = cand;
      continue;
    }
    flushBuf();
    if (utf8ByteLength(p) <= maxBytes) {
      buf = p;
    } else {
      out.push(...hardSplitUtf8ToTtsChunks(p, maxBytes));
    }
  }
  flushBuf();
  return out.length ? out : hardSplitUtf8ToTtsChunks(t, maxBytes);
}

function hardSplitUtf8ToTtsChunks(s, maxBytes) {
  const out = [];
  let rest = s;
  while (rest.length) {
    if (utf8ByteLength(rest) <= maxBytes) {
      const z = rest.trim();
      if (z) out.push(z);
      break;
    }
    let lo = 1;
    let hi = rest.length;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const part = rest.slice(0, mid);
      if (utf8ByteLength(part) <= maxBytes) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    let cut = best;
    const head = rest.slice(0, best);
    const breakAt = Math.max(
      head.lastIndexOf(' '),
      head.lastIndexOf('\u00A0'),
      head.lastIndexOf(','),
      head.lastIndexOf(';'),
      head.lastIndexOf('—'),
    );
    if (breakAt > 0 && breakAt >= Math.floor(best * 0.45)) {
      cut = breakAt + 1;
    }
    let piece = rest.slice(0, cut).trim();
    if (!piece) {
      cut = best;
      piece = rest.slice(0, cut).trim();
    }
    if (piece) out.push(piece);
    rest = rest.slice(cut).trim();
  }
  return out.filter(Boolean);
}

/** One entry per script segment (title + lines); each may become several TTS requests. */
function expandTtsSegments(segments) {
  const chunks = [];
  const logicalSegmentIndex = [];
  segments.forEach((seg, idx) => {
    const parts = splitStringToTtsChunks(seg, TTS_MAX_CHUNK_BYTES);
    for (const p of parts) {
      chunks.push(p);
      logicalSegmentIndex.push(idx);
    }
  });
  return { chunks, logicalSegmentIndex };
}

async function resampleAudioBufferTo48k(buffer) {
  if (buffer.sampleRate === TTS_MIX_SAMPLE_RATE) return buffer;
  const ch = buffer.numberOfChannels;
  const length = Math.ceil(buffer.duration * TTS_MIX_SAMPLE_RATE);
  const offline = new OfflineAudioContext(ch, length, TTS_MIX_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

/**
 * Linear crossfade merge: avoids abrupt boundaries when many short MP3 segments are concatenated.
 */
function mergeAudioBuffersWithCrossfade(buffers, crossfadeSamples) {
  const sr = TTS_MIX_SAMPLE_RATE;
  const ch = Math.min(2, buffers[0].numberOfChannels);
  const n = buffers.length;
  const cf = Math.max(
    0,
    Math.min(
      crossfadeSamples,
      ...buffers.map((b) => Math.max(0, Math.floor(b.length / 4) - 1)),
    ),
  );

  if (n === 1) {
    return {
      merged: buffers[0],
      startTimesMs: [0],
      totalDurationMs: (buffers[0].length / sr) * 1000,
    };
  }

  let totalLen = buffers[0].length;
  for (let i = 1; i < n; i++) {
    totalLen += buffers[i].length - cf;
  }

  const factory = new OfflineAudioContext(1, 1, sr);
  const merged = factory.createBuffer(ch, totalLen, sr);

  const startTimesMs = [];
  let write = 0;
  for (let i = 0; i < n; i++) {
    const segmentStartSample = i === 0 ? 0 : write - cf;
    startTimesMs.push((segmentStartSample / sr) * 1000);
    const b = buffers[i];
    for (let c = 0; c < ch; c++) {
      const srcCh = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      const dst = merged.getChannelData(c);
      if (i === 0) {
        for (let s = 0; s < b.length; s++) {
          dst[write + s] = srcCh[s];
        }
      } else {
        for (let s = 0; s < cf && s < b.length; s++) {
          const alpha = s / Math.max(1, cf);
          const pos = write - cf + s;
          dst[pos] = dst[pos] * (1 - alpha) + srcCh[s] * alpha;
        }
        for (let s = cf; s < b.length; s++) {
          dst[write + s - cf] = srcCh[s];
        }
      }
    }
    write += i === 0 ? b.length : b.length - cf;
  }

  return {
    merged,
    startTimesMs,
    totalDurationMs: (totalLen / sr) * 1000,
  };
}

async function buildSyncedAudioStream(segments, blobs) {
  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = [];
  try {
    for (let i = 0; i < blobs.length; i++) {
      if (!blobs[i] || blobs[i].size === 0) {
        console.warn('[TTS] missing or empty MP3 blob; aborting merge', {
          index: i,
          preview: String(segments[i] || '').slice(0, 80),
        });
        return { stream: null, startTimesMs: [], totalDurationMs: 0, segmentTexts: [] };
      }
      let buf;
      try {
        const arrayBuffer = await blobs[i].arrayBuffer();
        buf = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
      } catch (e) {
        console.warn('[TTS] decodeAudioData failed', { index: i, message: e?.message });
        return { stream: null, startTimesMs: [], totalDurationMs: 0, segmentTexts: [] };
      }
      if (!Number.isFinite(buf.duration) || buf.duration < TTS_MIN_SEGMENT_SEC) {
        console.warn('[TTS] segment decode too short or invalid; aborting merge', {
          index: i,
          duration: buf.duration,
          preview: String(segments[i] || '').slice(0, 80),
        });
        return { stream: null, startTimesMs: [], totalDurationMs: 0, segmentTexts: [] };
      }
      decoded.push({ buffer: buf, text: segments[i] });
    }
  } finally {
    try {
      await decodeCtx.close();
    } catch (_) {}
  }
  if (!decoded.length) return { stream: null, startTimesMs: [], totalDurationMs: 0, segmentTexts: [] };

  const segmentTexts = decoded.map((d) => d.text);
  const resampled = [];
  for (let i = 0; i < decoded.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const rb = await resampleAudioBufferTo48k(decoded[i].buffer);
    resampled.push(rb);
  }

  const crossfadeSamples = Math.floor((TTS_CROSSFADE_MS / 1000) * TTS_MIX_SAMPLE_RATE);
  const { merged, startTimesMs, totalDurationMs } = mergeAudioBuffersWithCrossfade(
    resampled,
    crossfadeSamples,
  );

  const playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TTS_MIX_SAMPLE_RATE });
  const dest = playCtx.createMediaStreamDestination();
  const src = playCtx.createBufferSource();
  src.buffer = merged;
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
  const baseSegments = [title, ...lines].map((s) => String(s || '').trim());
  let logicalSegmentIndex = [];
  let audioStream = null;
  let startPlayback = null;
  let startTimesMs = [];
  let totalDurationMs = 0;
  let segmentTexts = [];

  try {
    const expanded = expandTtsSegments(baseSegments);
    let ttsChunks = expanded.chunks;
    logicalSegmentIndex = expanded.logicalSegmentIndex;

    let blobs = await fetchTtsBlobsRobust(ttsBase, ttsChunks);

    if (blobs.length === ttsChunks.length && blobs.every((b) => b && b.size > 0)) {
      const synced = await buildSyncedAudioStream(ttsChunks, blobs);
      audioStream = synced.stream;
      startPlayback = synced.startPlayback;
      startTimesMs = synced.startTimesMs;
      totalDurationMs = synced.totalDurationMs;
      segmentTexts = synced.segmentTexts;
    }

    if (!audioStream) {
      const fb = expandTtsSegments([baseSegments.join('. ')]);
      ttsChunks = fb.chunks;
      logicalSegmentIndex = fb.logicalSegmentIndex;
      const fallbackBlobs = await fetchTtsBlobsRobust(ttsBase, ttsChunks);
      if (fallbackBlobs.length === ttsChunks.length && fallbackBlobs.every((b) => b && b.size > 0)) {
        const single = await buildSyncedAudioStream(ttsChunks, fallbackBlobs);
        if (single.stream) {
          audioStream = single.stream;
          startPlayback = single.startPlayback;
          startTimesMs = single.startTimesMs;
          totalDurationMs = single.totalDurationMs;
          segmentTexts = single.segmentTexts;
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

  if (logicalSegmentIndex.length !== segmentTexts.length) {
    logicalSegmentIndex = segmentTexts.map((_, i) => i);
  }

  if (!segmentTexts.length && baseSegments.length) {
    segmentTexts = [...baseSegments];
    const fixed = 5000;
    if (!startTimesMs.length) {
      startTimesMs = baseSegments.map((_, i) => i * fixed);
      totalDurationMs = Math.max(totalDurationMs, baseSegments.length * fixed);
    }
  }

  // 2) Background: AI-generated images (sequence matched to subtitle timing)
  const bgImageDataUrls = Array.isArray(bgGen?.images) ? bgGen.images : [];
  const selectedSegmentIndexes = Array.isArray(bgGen?.selectedSegmentIndexes) ? bgGen.selectedSegmentIndexes : [];

  const bgImages = [];
  for (let bi = 0; bi < bgImageDataUrls.length; bi++) {
    const dataUrl = bgImageDataUrls[bi];
    // eslint-disable-next-line no-await-in-loop
    const drawable = await loadDataUrlAsDrawable(dataUrl);
    if (drawable) {
      bgImages.push(drawable);
    } else {
      console.warn('[video] Skipping unreadable background frame', bi);
    }
  }
  if (bgImageDataUrls.length && !bgImages.length) {
    console.warn(
      '[video] No background images could be decoded (check /api/generate-images payload size and browser limits).',
    );
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

  /** Maps each TTS clip index (possibly multiple per script line) to a background image. */
  function buildSegmentToImageIndexForTts(ttsCount, logicalIdx, selected) {
    const idx = logicalIdx.length === ttsCount ? logicalIdx : Array.from({ length: ttsCount }, (_, i) => i);
    const maxLogical = idx.length ? Math.max(...idx) : 0;
    const perLogical = buildSegmentToImageIndex(maxLogical + 1, selected);
    return Array.from({ length: ttsCount }, (_, i) => perLogical[idx[i]] ?? 0);
  }

  const segmentToImageIndex = buildSegmentToImageIndexForTts(
    segmentTexts.length,
    logicalSegmentIndex,
    selectedSegmentIndexes,
  );

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

    ctx.fillStyle = '#0f0f12';
    ctx.fillRect(0, 0, width, height);
    try {
      if (bgImages.length) {
        const idx = getSegmentIndex(elapsed);
        const imgIdx = segmentToImageIndex[idx] ?? 0;
        const bgImg = bgImages[imgIdx];
        if (bgImg) {
          ctx.drawImage(bgImg, 0, 0, width, height);
        }
      } else {
        const fb = ctx.createLinearGradient(0, 0, width, height);
        fb.addColorStop(0, '#2a1f3d');
        fb.addColorStop(0.5, '#1c2742');
        fb.addColorStop(1, '#0d1829');
        ctx.fillStyle = fb;
        ctx.fillRect(0, 0, width, height);
      }
    } catch (e) {
      console.warn('[video] drawFrame background draw failed', e);
    }

    const grd = ctx.createLinearGradient(0, height * 0.45, 0, height);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, width, height);

    const titlePadX = 20;
    const titleMaxW = width - titlePadX * 2;
    const titleLayout = layoutTitleForCanvas(ctx, title, titleMaxW, 4);
    const titleBoxW = width - titlePadX * 2;
    const titleBoxX = titlePadX;
    const titleCenterY = height * 0.24;
    const titleBoxY = Math.max(12, titleCenterY - titleLayout.boxHeight / 2);

    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    fillRoundRect(ctx, titleBoxX, titleBoxY, titleBoxW, titleLayout.boxHeight, 14);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${titleLayout.fontSize}px system-ui, "Segoe UI", sans-serif`;
    const titleStartY = titleBoxY + 14 + titleLayout.lineHeight / 2;
    for (let ti = 0; ti < titleLayout.lines.length; ti++) {
      ctx.fillText(titleLayout.lines[ti], width / 2, titleStartY + ti * titleLayout.lineHeight);
    }

    const idx = getSegmentIndex(elapsed);
    // Show full script line for subtitles (TTS may split one line into many audio chunks).
    let current = '';
    if (logicalSegmentIndex.length > idx) {
      current = String(baseSegments[logicalSegmentIndex[idx]] ?? '').trim();
    }
    if (!current) {
      current = String(segmentTexts[idx] ?? '').trim();
    }
    if (!current && baseSegments.length) {
      const bi = Math.min(idx, baseSegments.length - 1);
      current = String(baseSegments[bi] ?? '').trim();
    }

    const subPadX = 20;
    const subPadY = 14;
    const subMaxW = width - subPadX * 2;
    const subFontSize = 28;
    const subLineH = 34;
    const maxSubLines = 8;
    ctx.font = `600 ${subFontSize}px system-ui, "Segoe UI", sans-serif`;
    let subLines = [];
    if (current.trim()) {
      subLines = wrapTextLines(ctx, current.slice(0, 420), subMaxW);
      if (subLines.length > maxSubLines) {
        subLines = subLines.slice(0, maxSubLines);
        const last = subLines[maxSubLines - 1];
        subLines[maxSubLines - 1] = last.length ? `${last.replace(/…$/, '')}…` : '…';
      }
    }
    const lineH = subLineH;
    if (subLines.length) {
      const subBoxH = Math.min(height * 0.32, Math.max(subPadY * 2 + lineH, subLines.length * lineH + subPadY * 2));
      const subBoxY = height - subBoxH;
      const subGrad = ctx.createLinearGradient(0, subBoxY, 0, height);
      subGrad.addColorStop(0, 'rgba(0,0,0,0.35)');
      subGrad.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = subGrad;
      fillRoundRect(ctx, 0, subBoxY, width, subBoxH, 0);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, subBoxY + 0.5);
      ctx.lineTo(width, subBoxY + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const textBottom = height - subPadY;
      for (let li = 0; li < subLines.length; li++) {
        const lineIdx = subLines.length - 1 - li;
        const y = textBottom - li * lineH;
        if (y >= subBoxY + subPadY) {
          ctx.fillText(subLines[lineIdx], width / 2, y);
        }
      }
    }

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

function wrapTextLines(ctx, text, maxWidth) {
  const raw = String(text || '').trim();
  if (!raw) return [''];
  const words = raw.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const pushLine = (s) => {
    const t = s.trimEnd();
    if (t) lines.push(t);
  };
  const breakLongWord = (word) => {
    const out = [];
    let chunk = '';
    for (let i = 0; i < word.length; i++) {
      const next = chunk + word[i];
      if (ctx.measureText(next).width > maxWidth && chunk) {
        out.push(chunk);
        chunk = word[i];
      } else {
        chunk = next;
      }
    }
    if (chunk) out.push(chunk);
    return out;
  };
  for (let n = 0; n < words.length; n++) {
    const w = words[n];
    if (ctx.measureText(w).width > maxWidth) {
      if (line) {
        pushLine(line);
        line = '';
      }
      const parts = breakLongWord(w);
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        const test = line ? `${line} ${part}` : part;
        if (ctx.measureText(test).width <= maxWidth) line = test;
        else {
          if (line) pushLine(line);
          line = part;
        }
      }
      continue;
    }
    const testLine = line ? `${line} ${w}` : w;
    if (ctx.measureText(testLine).width <= maxWidth) line = testLine;
    else {
      if (line) pushLine(line);
      line = w;
    }
  }
  if (line) pushLine(line);
  return lines.length ? lines : [''];
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const lines = wrapTextLines(ctx, text, maxWidth);
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => {
    ctx.fillText(l, x, startY + i * lineHeight);
  });
}

/** Title: shrink font until it fits in maxLines, so long Vietnamese titles stay on-screen. */
function layoutTitleForCanvas(ctx, rawTitle, maxWidth, maxLines) {
  const t = String(rawTitle || '').trim().slice(0, 220);
  if (!t) return { fontSize: 48, lines: [''], lineHeight: 56, boxHeight: 72 };
  let fontSize = 52;
  let lines = [''];
  for (let attempt = 0; attempt < 12 && fontSize >= 26; attempt++) {
    ctx.font = `bold ${fontSize}px system-ui, "Segoe UI", sans-serif`;
    lines = wrapTextLines(ctx, t, maxWidth);
    if (lines.length <= maxLines) break;
    fontSize -= 3;
  }
  ctx.font = `bold ${fontSize}px system-ui, "Segoe UI", sans-serif`;
  lines = wrapTextLines(ctx, t, maxWidth);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.length > 1 ? `${last.slice(0, Math.max(0, last.length - 1))}…` : '…';
  }
  const lineHeight = Math.round(fontSize * 1.2);
  const boxHeight = lines.length * lineHeight + 28;
  return { fontSize, lines, lineHeight, boxHeight };
}

function fillRoundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, w, h);
  }
}

async function generateVideo() {
  if (btnVideo.disabled) return;
  const prompt = promptEl.value.trim();
  if (!prompt) {
    showMessage('Enter a prompt first.', 'error');
    return;
  }
  btnVideo.dataset.label = 'Generate video';
  setLoading(btnVideo, true);
  hideMessage();
  setTokenUsage(null);
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
    if (!res.ok) {
      let msg = data.error || `Request failed: ${res.status}`;
      if (res.status === 429 && data.retryAfterSeconds) {
        msg += ` (try again in ~${data.retryAfterSeconds}s)`;
      }
      throw new Error(msg);
    }
    if (!data.title || !Array.isArray(data.lines) || !data.lines.length) {
      throw new Error('Script is empty. Try another prompt.');
    }
    setTokenUsage(data);

    previewPlaceholder.textContent = 'Generating AI background images…';
    // Generate more scene-matched images for better story continuity.
    // Keep request size moderate to avoid proxy/network drops on huge base64 responses.
    const desiredImages = Math.min(Math.max(data.lines.length + 1, 8), 16);
    const bgGen = await fetchAiBackgroundImages(data.title, data.lines, desiredImages);
    previewPlaceholder.textContent = 'Rendering video… (may take a bit)';
    currentVideoBlob = await renderScriptToVideo(data.title, data.lines, bgGen);

    previewVideo.loop = false;
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
