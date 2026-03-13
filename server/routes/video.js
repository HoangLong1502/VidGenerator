import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = Router();

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// Default to a widely available text model; can override via GEMINI_SCRIPT_MODEL
const SCRIPT_MODEL = process.env.GEMINI_SCRIPT_MODEL || 'gemini-1.0-pro';

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
    const model = genAI.getGenerativeModel({ model: SCRIPT_MODEL });

    const systemPrompt = `
You write short, funny meme scripts for vertical videos with an animated GIF background.

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

    const result = await model.generateContent(
      `${systemPrompt}\n\nUser topic: ${prompt.trim()}`
    );

    const text = result.response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
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
