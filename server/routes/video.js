import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = Router();

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// Default to a widely available text model; can override via GEMINI_SCRIPT_MODEL
const SCRIPT_MODEL = process.env.GEMINI_SCRIPT_MODEL || 'gemini-1.0-pro';
const SCRIPT_FALLBACK_MODELS = String(
  process.env.GEMINI_SCRIPT_FALLBACK_MODELS || 'gemini-1.5-flash,gemini-1.0-pro',
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const SCRIPT_MAX_RETRIES = Number(process.env.GEMINI_SCRIPT_MAX_RETRIES || 3);

function isTransientGeminiError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('503') || msg.includes('service unavailable') || msg.includes('high demand') || msg.includes('429');
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (raw.startsWith('{') && raw.endsWith('}')) return raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1).trim();
  return raw;
}

router.post('/', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt' });
  }
  if (!genAI) {
    return res.status(503).json({
      error: 'Script generation not configured. Set GEMINI_API_KEY in .env (get a free key at https://aistudio.google.com/apikey).',
    });
  }

  try {
    const systemPrompt = `
You write short, funny meme scripts for vertical videos.

The app will generate a sequence of background images from your TITLE and each LINE.
So keep each LINE vivid and descriptive (without writing any quotes).

Given a topic from the user, produce:
- A short TITLE (max 60 characters).
- 15-30 short LINES (max ~80 characters each) that could be shown as subtitles.

Return ONLY JSON in this exact shape:
{
  "title": "Title text here",
  "lines": [
    "first subtitle line",
    "second subtitle line"
  ]
}
Do not add any extra text before or after the JSON.
`;

    const modelCandidates = [SCRIPT_MODEL, ...SCRIPT_FALLBACK_MODELS].filter(
      (m, i, arr) => arr.indexOf(m) === i,
    );
    let lastErr = null;
    let text = '';

    for (const modelName of modelCandidates) {
      const model = genAI.getGenerativeModel({ model: modelName });
      for (let attempt = 0; attempt <= SCRIPT_MAX_RETRIES; attempt++) {
        try {
          const result = await model.generateContent(
            `${systemPrompt}\n\nUser topic: ${prompt.trim()}`,
          );
          text = result.response.text();
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (!isTransientGeminiError(e) || attempt === SCRIPT_MAX_RETRIES) break;
          const delayMs = 1200 * (attempt + 1);
          // Backoff for temporary load spikes.
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      if (!lastErr && text) break;
    }

    if (lastErr && !text) throw lastErr;

    let parsed;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch {
      return res.status(502).json({
        error: 'Gemini returned invalid JSON for script. Try a different prompt.',
      });
    }

    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const lines =
      Array.isArray(parsed.lines) && parsed.lines.length
        ? parsed.lines
            .map((l) => String(l || '').trim())
            .filter((l) => l.length > 0)
        : [];

    if (!title || !lines.length) {
      return res.status(502).json({
        error: 'Gemini did not return a usable script. Try again with a clearer prompt.',
      });
    }

    res.json({ title, lines });
  } catch (err) {
    console.error('Gemini script error:', err);
    const msg = err.message || 'Script generation failed';
    const status = msg.toLowerCase().includes('api key') ? 401 : 502;
    res.status(status).json({ error: msg });
  }
});

export { router as videoRouter };
