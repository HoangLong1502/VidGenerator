import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { videoRouter } from './routes/video.js';
import { youtubeRouter } from './routes/youtube.js';
import { tiktokRouter } from './routes/tiktok.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distIndex = path.join(__dirname, '../dist/index.html');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../dist')));

app.use('/api/generate-video', videoRouter);
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
app.post('/api/tts', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing text for TTS' });
  }
  try {
    const r = await fetch('http://127.0.0.1:8001/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.error('TTS error:', r.status, err);
      return res.status(502).json({ error: 'TTS server failed' });
    }
    const buf = await r.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
