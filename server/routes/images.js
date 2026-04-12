import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';

const router = Router();

const IMAGE_PROVIDER = String(process.env.IMAGE_PROVIDER || 'gemini').toLowerCase();
const DEFAULT_MAX_IMAGES = Number(process.env.MAX_BG_IMAGES || 8);
const DEFAULT_STYLE_PRESET = String(process.env.IMAGE_STYLE_PRESET || 'digital_art');

const DEFAULT_NEGATIVE_PROMPT =
  [
    'text',
    'subtitles',
    'captions',
    'watermark',
    'logo',
    'signature',
    'blurry',
    'low-res',
    'artifacts',
    'human face',
    'human portrait',
    'close-up face',
    'realistic person',
    'boring background',
    'plain room',
    'empty scene',
    'dull composition',
    'monotone colors',
    'photorealistic',
    '3d render',
    'complex background',
    'highly detailed texture',
    'real skin',
    'cinematic realistic lighting',
  ].join(', ');

// Gemini provider (paid may be required depending on account).
const genAI =
  IMAGE_PROVIDER === 'gemini' && process.env.GEMINI_API_KEY
    ? new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          apiVersion: process.env.GEMINI_IMAGE_API_VERSION || 'v1beta',
        },
      })
    : null;

const IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || 'imagen-4.0-generate-001';

// Legacy keyless API: https://image.pollinations.ai/prompt/... (gen.pollinations.ai requires an API key)
const POLLINATIONS_DEFAULT_MODEL = 'zimage';

function resolveModelUsedLabel() {
  if (IMAGE_PROVIDER === 'pollinations') {
    return process.env.POLLINATIONS_MODEL || POLLINATIONS_DEFAULT_MODEL;
  }
  if (IMAGE_PROVIDER === 'a1111') {
    return 'a1111';
  }
  return IMAGE_MODEL;
}

// Global single-flight queue for Pollinations (free tier is strict per IP).
let pollinationsSerial = Promise.resolve();

function runPollinationsSerial(task) {
  const next = pollinationsSerial.then(task, task);
  pollinationsSerial = next.catch(() => {});
  return next;
}

function bufferToDataUrl(buffer, mimeType = 'image/jpeg') {
  const b64 = Buffer.from(buffer).toString('base64');
  return `data:${mimeType};base64,${b64}`;
}

// Free hosted provider (no API key): Pollinations
async function generateViaPollinations({ title, scene }) {
  const stylePreset = String(process.env.IMAGE_STYLE_PRESET || DEFAULT_STYLE_PRESET).toLowerCase();
  const width = Number(process.env.POLLINATIONS_WIDTH || 720);
  const height = Number(process.env.POLLINATIONS_HEIGHT || 1280);
  const model = process.env.POLLINATIONS_MODEL || POLLINATIONS_DEFAULT_MODEL;
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const enhance =
    String(process.env.POLLINATIONS_ENHANCE || 'true').toLowerCase() === 'true';
  const styleText =
    stylePreset === 'digital_art'
      ? [
          'simple doodle digital art',
          'thick black outline',
          'flat pastel colors',
          'minimal shading',
          'cute goofy cartoon mascot',
          'plain light gray background',
          'clean minimal composition',
        ].join(', ')
      : 'illustration, clean composition';

  const prompt = [
    'vertical meme background, 9:16',
    styleText,
    'centered full-body character',
    'simple hand-drawn meme vibe',
    'no text, no watermark, no logo',
    'no visible human face, no realistic portrait',
    'absurd funny chaotic visual gag, surreal props, dynamic composition',
    `theme: ${safeTrim(title, 140)}`,
    `moment: ${safeTrim(scene, 180)}`,
  ].join(', ');

  const base = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  const url =
    `${base}?model=${encodeURIComponent(model)}` +
    `&width=${width}&height=${height}&seed=${seed}&nologo=true` +
    (enhance ? '&enhance=true' : '');

  return runPollinationsSerial(async () => {
    let r;
    let lastErr = '';
    const maxRetries = Number(process.env.POLLINATIONS_MAX_RETRIES || 6);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        r = await fetch(url, {
          headers: {
            Accept: 'image/*',
          },
        });
      } catch (e) {
        lastErr = e?.message || 'fetch failed';
        r = null;
      }

      if (r?.ok) break;

      const isRateLimited = r?.status === 429;
      const isLast = attempt === maxRetries;
      const text = r ? await r.text().catch(() => '') : '';
      lastErr = text || lastErr || r?.statusText || 'request failed';

      if (isLast || !isRateLimited) {
        throw new Error(`Pollinations error (${r?.status || 'network'}): ${lastErr}`);
      }

      // Queue-full on free tier can persist while prior job is rendering.
      // Wait longer between retries to let the active job finish.
      const delayMs = 8000 + attempt * 4000;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    if (!r?.ok) {
      throw new Error(`Pollinations error: ${lastErr || 'request failed'}`);
    }

    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const arr = await r.arrayBuffer();
    return bufferToDataUrl(arr, contentType);
  });
}

// Stable Diffusion local provider (free, uses your own machine).
async function generateViaA1111({ title, scene }) {
  const sdApiBase = process.env.SD_API_URL || 'http://127.0.0.1:7860';
  const width = Number(process.env.SD_WIDTH || 576);
  const height = Number(process.env.SD_HEIGHT || 1024);
  const steps = Number(process.env.SD_STEPS || 28);
  const cfgScale = Number(process.env.SD_CFG_SCALE || 7);
  const samplerName = process.env.SD_SAMPLER_NAME || 'DPM++ 2M Karras';
  const negativePrompt = process.env.SD_NEGATIVE_PROMPT || DEFAULT_NEGATIVE_PROMPT;
  const stylePreset = String(process.env.IMAGE_STYLE_PRESET || DEFAULT_STYLE_PRESET).toLowerCase();
  const styleText =
    stylePreset === 'digital_art'
      ? 'Simple doodle digital art style, thick black lines, flat colors, minimal shading, goofy cute mascot on a plain light gray background.'
      : 'Illustration style, clean composition.';

  const prompt = [
    'Vertical 9:16 meme background image.',
    'No readable text. No subtitles. No logos. No watermarks. No captions.',
    styleText,
    'Character-first composition. Keep one centered full-body mascot silhouette.',
    'Simple hand-drawn meme vibe, clean bold outline, minimal clutter.',
    'No visible human face. Avoid realistic people and portraits.',
    'Make it absurd, chaotic, and funny meme energy. Weird visual gag, exaggerated action, surreal props.',
    'Avoid bland scenes. Use dramatic framing, dynamic motion, and playful visual contrast.',
    'Portrait framing, clear subject, leave safe margins for overlay text.',
    `Theme: ${safeTrim(title, 160)}`,
    `Moment: ${safeTrim(scene, 180)}.`,
    'Avoid any letterforms or numbers.',
  ].join(' ');

  const url = `${sdApiBase.replace(/\/$/, '')}/sdapi/v1/txt2img`;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        negative_prompt: negativePrompt,
        steps,
        cfg_scale: cfgScale,
        sampler_name: samplerName,
        width,
        height,
        batch_size: 1,
        n_iter: 1,
        restore_faces: false,
        enable_hr: false,
      }),
    });
  } catch (e) {
    throw new Error(`Could not reach A1111 at ${url}: ${e?.message || 'fetch failed'}`);
  }

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`A1111 error (${r.status}): ${text || r.statusText}`);
  }

  const data = await r.json().catch(() => ({}));
  const imageB64 = data?.images?.[0];
  if (!imageB64) throw new Error('A1111 returned no images');

  // A1111 returns base64 without mime; it’s usually PNG.
  return `data:image/png;base64,${imageB64}`;
}

function safeTrim(s, maxLen = 220) {
  return String(s || '').trim().slice(0, maxLen);
}

function pickSelectedSegmentIndexes(totalSegments, targetCount) {
  const total = Math.max(1, totalSegments);
  const target = Math.max(1, Math.min(targetCount, total));

  if (target === 1) return [0];

  const out = [];
  for (let i = 0; i < target; i++) {
    const idx = Math.round((i * (total - 1)) / (target - 1));
    out.push(idx);
  }

  // De-dup (can happen due to rounding).
  return [...new Set(out)];
}

async function generateBackgroundImage({ title, scene }) {
  if (IMAGE_PROVIDER === 'a1111') {
    return generateViaA1111({ title, scene });
  }
  if (IMAGE_PROVIDER === 'pollinations') {
    return generateViaPollinations({ title, scene });
  }

  if (!genAI) {
    throw new Error('Image generation not configured. Use IMAGE_PROVIDER=pollinations, a1111, or set GEMINI_API_KEY.');
  }

  const stylePreset = String(process.env.IMAGE_STYLE_PRESET || DEFAULT_STYLE_PRESET).toLowerCase();
  const styleText =
    stylePreset === 'digital_art'
      ? 'Style: simple doodle digital art, thick black lines, flat colors, cute goofy mascot, plain light gray background.'
      : 'Style: illustration, simple composition.';

  const prompt = [
    'Create a vertical 9:16 meme background image.',
    'No readable text. No subtitles. No logos. No watermarks. No captions.',
    styleText,
    'Character-first composition, centered full body, simple silhouette.',
    'Simple hand-drawn meme vibe, clean bold outline, minimal clutter.',
    'No visible human face. Avoid realistic people and portraits.',
    'Make it absurd, chaotic, and funny meme energy. Weird visual gag, exaggerated action, surreal props.',
    'Avoid bland scenes. Use dramatic framing, dynamic motion, and playful visual contrast.',
    'Composition: portrait framing, clear subject, leave safe margins for overlay text.',
    `Meme theme: ${safeTrim(title, 160)}`,
    `Current moment: ${safeTrim(scene, 180)}.`,
    'Avoid: any text, numbers, subtitles, watermarks, logos, signatures, blur, artifacts, low resolution, visible human face, boring background.',
  ].join(' ');

  const config = {
    aspectRatio: '9:16',
    numberOfImages: 1,
  };

  const response = await genAI.models.generateImages({
    model: IMAGE_MODEL,
    prompt,
    config,
  });

  const item = response?.generatedImages?.[0];
  const imageBytes = item?.image?.imageBytes;
  const mimeType = item?.image?.mimeType || 'image/png';
  if (!imageBytes) {
    throw new Error('Image generation returned empty image data');
  }

  return `data:${mimeType};base64,${imageBytes}`;
}

router.post('/', async (req, res) => {
  const { title, lines, maxImages } = req.body || {};

  const titleStr = safeTrim(title, 200);
  const linesArr = Array.isArray(lines) ? lines : [];
  const linesStr = linesArr.map((l) => safeTrim(l, 200)).filter((l) => l.length > 0);

  if (!titleStr) return res.status(400).json({ error: 'Missing or invalid title' });
  if (!linesStr.length) return res.status(400).json({ error: 'Missing or invalid lines' });
  if (!['a1111', 'pollinations'].includes(IMAGE_PROVIDER) && !genAI) {
    return res.status(503).json({
      error: 'Image generation not configured. Use IMAGE_PROVIDER=pollinations, a1111, or set GEMINI_API_KEY.',
    });
  }

  const segments = [titleStr, ...linesStr];
  const targetMax = Number.isFinite(Number(maxImages)) ? Number(maxImages) : DEFAULT_MAX_IMAGES;
  const providerMax =
    IMAGE_PROVIDER === 'pollinations'
      ? Number(process.env.POLLINATIONS_MAX_IMAGES || targetMax)
      : targetMax;
  const selectedSegmentIndexes = pickSelectedSegmentIndexes(segments.length, Math.min(targetMax, providerMax));

  try {
    // Keep it simple: sequential generation to reduce rate-limit errors.
    const images = [];
    for (let i = 0; i < selectedSegmentIndexes.length; i++) {
      const segIdx = selectedSegmentIndexes[i];
      const scene = segments[segIdx];
      // eslint-disable-next-line no-await-in-loop
      const dataUrl = await generateBackgroundImage({ title: titleStr, scene });
      images.push(dataUrl);
      if (IMAGE_PROVIDER === 'pollinations' && i < selectedSegmentIndexes.length - 1) {
        // Keep requests spaced out to avoid per-IP queue throttling.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.POLLINATIONS_BETWEEN_MS || 1200)));
      }
    }

    res.json({
      images,
      selectedSegmentIndexes,
      modelUsed: resolveModelUsedLabel(),
      aspectRatio: '9:16',
    });
  } catch (e) {
    console.error('AI image error:', e);
    const msg = e?.message || 'Image generation failed';
    const status = msg.toLowerCase().includes('api key') ? 401 : 502;
    res.status(status).json({ error: msg });
  }
});

export { router as imagesRouter };

