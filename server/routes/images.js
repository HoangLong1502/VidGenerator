import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';

const router = Router();

const IMAGE_PROVIDER = String(process.env.IMAGE_PROVIDER || 'gemini').toLowerCase();
const DEFAULT_MAX_IMAGES = Number(process.env.MAX_BG_IMAGES || 8);
const DEFAULT_STYLE_PRESET = String(process.env.IMAGE_STYLE_PRESET || 'digital_art');

const DEFAULT_NEGATIVE_PROMPT =
  'text, subtitles, captions, watermark, logo, signature, blurry, low-res, artifacts';

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
      ? 'Digital art style, clean shapes, soft gradients, vibrant but balanced colors, simple composition.'
      : 'Illustration style, clean composition.';

  const prompt = [
    'Vertical 9:16 meme background image.',
    'No readable text. No subtitles. No logos. No watermarks. No captions.',
    styleText,
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

  if (!genAI) {
    throw new Error('Image generation not configured. Set GEMINI_API_KEY or IMAGE_PROVIDER=a1111.');
  }

  const stylePreset = String(process.env.IMAGE_STYLE_PRESET || DEFAULT_STYLE_PRESET).toLowerCase();
  const styleText =
    stylePreset === 'digital_art'
      ? 'Style: digital art, simple composition, clean details, soft gradients, vibrant cinematic colors.'
      : 'Style: illustration, simple composition.';

  const prompt = [
    'Create a vertical 9:16 meme background image.',
    'No readable text. No subtitles. No logos. No watermarks. No captions.',
    styleText,
    'Composition: portrait framing, clear subject, leave safe margins for overlay text.',
    `Meme theme: ${safeTrim(title, 160)}`,
    `Current moment: ${safeTrim(scene, 180)}.`,
    'Avoid: any text, numbers, subtitles, watermarks, logos, signatures, blur, artifacts, low resolution.',
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
  if (IMAGE_PROVIDER !== 'a1111' && !genAI) {
    return res.status(503).json({
      error: 'Image generation not configured. Set GEMINI_API_KEY or IMAGE_PROVIDER=a1111.',
    });
  }

  const segments = [titleStr, ...linesStr];
  const targetMax = Number.isFinite(Number(maxImages)) ? Number(maxImages) : DEFAULT_MAX_IMAGES;
  const selectedSegmentIndexes = pickSelectedSegmentIndexes(segments.length, targetMax);

  try {
    // Keep it simple: sequential generation to reduce rate-limit errors.
    const images = [];
    for (let i = 0; i < selectedSegmentIndexes.length; i++) {
      const segIdx = selectedSegmentIndexes[i];
      const scene = segments[segIdx];
      // eslint-disable-next-line no-await-in-loop
      const dataUrl = await generateBackgroundImage({ title: titleStr, scene });
      images.push(dataUrl);
    }

    res.json({
      images,
      selectedSegmentIndexes,
      modelUsed: IMAGE_MODEL,
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

