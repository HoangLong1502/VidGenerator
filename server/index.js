import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { videoRouter } from './routes/video.js';
import { imagesRouter } from './routes/images.js';
import { youtubeRouter } from './routes/youtube.js';
import { tiktokRouter } from './routes/tiktok.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distIndex = path.join(__dirname, '../dist/index.html');
const app = express();
const PORT = process.env.PORT || 3001;
const TTS_PROXY_TIMEOUT_MS = Number(process.env.TTS_PROXY_TIMEOUT_MS || 60000);
const TTS_PROXY_MAX_RETRIES = Number(process.env.TTS_PROXY_MAX_RETRIES || 3);
const DEFAULT_TTS_VOICE = 'vi-VN-HoaiMyNeural';

function resolveTtsVoice(req) {
  const fromBody = req.body?.voice;
  const candidate =
    typeof fromBody === 'string' && fromBody.trim()
      ? fromBody.trim()
      : String(process.env.TTS_VOICE || DEFAULT_TTS_VOICE).trim();
  // Edge short names, e.g. vi-VN-HoaiMyNeural or en-US-AvaMultilingualNeural (experiment).
  if (/^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(candidate)) return candidate;
  return DEFAULT_TTS_VOICE;
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

app.use(cors({ origin: true, credentials: true }));
// generate-images returns many base64 data URLs; 10mb is easy to exceed.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '64mb' }));
app.use(express.static(path.join(__dirname, '../dist')));

// Debug access log for API calls that may fail silently in the browser.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const start = Date.now();
  const originalUrl = req.originalUrl;
  const method = req.method;
  res.on('finish', () => {
    const elapsed = Date.now() - start;
    console.log(`[api] ${method} ${originalUrl} -> ${res.statusCode} (${elapsed}ms)`);
  });
  next();
});

app.use('/api/generate-video', videoRouter);
app.use('/api/generate-images', imagesRouter);
app.use('/api/youtube', youtubeRouter);
app.use('/api/tiktok', tiktokRouter);

const GIF_KEYWORDS = ['funny cat', 'funny dog', 'meme', 'reaction', 'brainrot'];

async function fetchTenorBackgrounds(limit) {
  const apiKey = process.env.TENOR_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('TENOR_API_KEY is missing in .env'), { status: 503 });
  }

  const q = GIF_KEYWORDS[Math.floor(Math.random() * GIF_KEYWORDS.length)];
  const url = new URL('https://tenor.googleapis.com/v2/search');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('client_key', 'vidgenerator');
  url.searchParams.set('media_filter', 'mp4,gif');

  const r = await fetch(url.toString());
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    console.error('Tenor API error', r.status, err);
    const status = r.status || 502;
    throw Object.assign(new Error('Tenor API error'), {
      status,
      details: err?.error?.message || r.statusText,
    });
  }
  const data = await r.json();
  // v2: results[].media_formats = { mp4: { url }, gif: { url }, ... }
  return (data.results || [])
    .map((g) => g.media_formats?.mp4?.url || g.media_formats?.gif?.url)
    .filter(Boolean);
}

async function fetchGiphyBackgrounds(limit) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('GIPHY_API_KEY is missing in .env'), { status: 503 });
  }

  const q = GIF_KEYWORDS[Math.floor(Math.random() * GIF_KEYWORDS.length)];
  const url = new URL('https://api.giphy.com/v1/gifs/search');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('rating', 'pg-13');

  const r = await fetch(url.toString());
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    console.error('GIPHY API error', r.status, err);
    const status = r.status || 502;
    throw Object.assign(new Error('GIPHY API error'), {
      status,
      details: err?.message || r.statusText,
    });
  }
  const data = await r.json();
  return (data.data || [])
    .map(
      (g) =>
        g.images?.original_mp4?.mp4 ||
        g.images?.downsized_large?.url ||
        g.images?.original?.url,
    )
    .filter(Boolean);
}

// Unified endpoint for random GIF/video URLs for background
app.get('/api/gifs', async (req, res) => {
  const limit = Number(req.query.limit || 10);
  const source = (process.env.GIF_SOURCE || 'giphy').toLowerCase();

  try {
    const urls =
      source === 'tenor'
        ? await fetchTenorBackgrounds(limit)
        : await fetchGiphyBackgrounds(limit);

    if (!urls.length) {
      return res.status(502).json({ error: 'No GIFs found from provider' });
    }
    res.json({ gifs: urls });
  } catch (e) {
    const status = e.status || 502;
    console.error('Background GIF fetch error', e);
    res.status(status).json({ error: e.message || 'Failed to fetch GIFs', details: e.details });
  }
});

// Proxy to Edge TTS server (run: uvicorn server:app --port 8001 in F:\coqui-tts-server)
// Set TTS_VOICE to an Edge neural voice id (default: Vietnamese female).
app.post('/api/tts', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing text for TTS' });
  }
  const voiceId = resolveTtsVoice(req);
  try {
    let lastErr = '';
    for (let attempt = 0; attempt <= TTS_PROXY_MAX_RETRIES; attempt++) {
      let r;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TTS_PROXY_TIMEOUT_MS);
      try {
        r = await fetch('http://127.0.0.1:8001/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: voiceId }),
          signal: controller.signal,
        });
      } catch (e) {
        lastErr = e?.name === 'AbortError' ? `timeout after ${TTS_PROXY_TIMEOUT_MS}ms` : (e?.message || 'fetch failed');
        r = null;
      } finally {
        clearTimeout(timeoutId);
      }

      if (r?.ok) {
        const buf = await r.arrayBuffer();
        res.setHeader('Content-Type', 'audio/mpeg');
        return res.send(Buffer.from(buf));
      }

      const status = Number(r?.status || 0);
      const body = r ? await r.text().catch(() => '') : '';
      lastErr = body || lastErr || r?.statusText || 'request failed';
      const isRetryable = !r || status >= 500;
      if (attempt < TTS_PROXY_MAX_RETRIES && isRetryable) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        continue;
      }
      break;
    }
    console.error('TTS error:', lastErr);
    res.status(502).json({ error: `TTS server failed: ${lastErr}` });
  } catch (e) {
    console.error('TTS request error:', e);
    res.status(502).json({ error: 'Could not reach TTS server (start it on port 8001)' });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('*', (_, res) => {
  if (fs.existsSync(distIndex)) {
    res.sendFile(distIndex);
  } else if (process.env.NODE_ENV !== 'production') {
    res.redirect(302, 'http://localhost:5173/');
  } else {
    res.status(404).send('Not found. Run: npm run build');
  }
});

// Last-resort Express error handler so we never drop connection without logs.
app.use((err, req, res, _next) => {
  console.error('[express-error]', req.method, req.path, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
