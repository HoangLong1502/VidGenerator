import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = Router();

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

// Default to a widely available text model; can override via GEMINI_SCRIPT_MODEL
function normalizeScriptModelName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  // Old alias that now returns 404 on v1beta.
  if (raw === 'gemini-1.5-flash') return 'gemini-flash-latest';
  return raw;
}

const SCRIPT_MODEL = normalizeScriptModelName(process.env.GEMINI_SCRIPT_MODEL || 'gemini-flash-latest');
const SCRIPT_FALLBACK_MODELS = String(
  process.env.GEMINI_SCRIPT_FALLBACK_MODELS || 'gemini-flash-latest',
)
  .split(',')
  .map((m) => normalizeScriptModelName(m))
  .filter(Boolean);
const SCRIPT_MAX_RETRIES = Number(process.env.GEMINI_SCRIPT_MAX_RETRIES || 3);
const SCRIPT_TOPIC_MAX_CHARS = Number(process.env.GEMINI_SCRIPT_TOPIC_MAX_CHARS || 240);
const SCRIPT_MIN_LINES = Number(process.env.GEMINI_SCRIPT_MIN_LINES || 10);
const SCRIPT_MAX_LINES = Number(process.env.GEMINI_SCRIPT_MAX_LINES || 14);
const SCRIPT_LINE_MAX_CHARS = Number(process.env.GEMINI_SCRIPT_LINE_MAX_CHARS || 70);
const SCRIPT_MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_SCRIPT_MAX_OUTPUT_TOKENS || 700);

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

function tryRecoverScript(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;

  // Attempt 0: partial JSON recovery (common when output is truncated).
  // Example: {"title":"...","lines":["a","b","c"
  const titleFromJson = raw.match(/"title"\s*:\s*"([^"]*)"/i)?.[1]?.trim() || '';
  const linesBlock = raw.match(/"lines"\s*:\s*\[([\s\S]*)$/i)?.[1] || '';
  const lineMatches = [...linesBlock.matchAll(/"([^"\n\r]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
  if (titleFromJson && lineMatches.length) {
    return {
      title: titleFromJson,
      lines: lineMatches,
    };
  }

  // Attempt 1: common "Title: ... / Lines: ..." free-form output.
  const titleMatch = raw.match(/(?:^|\n)\s*title\s*[:\-]\s*(.+)/i);
  const numberedLines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+[\)\.\-]\s+/.test(line))
    .map((line) => line.replace(/^\d+[\)\.\-]\s+/, '').trim())
    .filter(Boolean);

  if (titleMatch?.[1] && numberedLines.length) {
    return {
      title: titleMatch[1].trim(),
      lines: numberedLines,
    };
  }

  // Attempt 2: bullet list without numbering.
  const bulletLines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);

  if (titleMatch?.[1] && bulletLines.length) {
    return {
      title: titleMatch[1].trim(),
      lines: bulletLines,
    };
  }

  return null;
}

function normalizeUsage(usageMetadata) {
  const u = usageMetadata || {};
  const promptTokens = Number(u.promptTokenCount || 0);
  const candidatesTokens = Number(u.candidatesTokenCount || 0);
  const thoughtsTokens = Number(u.thoughtsTokenCount || 0);
  const totalTokens = Number(
    u.totalTokenCount || promptTokens + candidatesTokens + thoughtsTokens,
  );

  return {
    promptTokens,
    candidatesTokens,
    thoughtsTokens,
    totalTokens,
  };
}

async function repairScriptJson({ genAIClient, modelName, rawText }) {
  const model = genAIClient.getGenerativeModel({
    model: modelName,
    generationConfig: {
      maxOutputTokens: 260,
      temperature: 0.1,
    },
  });

  const repairPrompt = [
    'Convert the following content to strict JSON only.',
    'Output format: {"title":"...","lines":["..."]}',
    'No markdown. No explanation. No extra keys.',
    'If content is unusable, return {"title":"","lines":[]}.',
    '',
    'CONTENT:',
    String(rawText || ''),
  ].join('\n');

  const result = await model.generateContent(repairPrompt);
  const repaired = result?.response?.text?.() || '';
  return extractJson(repaired);
}

function buildFallbackScript(topic, maxLines, lineMaxChars) {
  const cleanTopic = String(topic || 'tinh huong hai huoc').trim() || 'tinh huong hai huoc';
  const title = `Meme: ${cleanTopic}`.slice(0, 60);
  const seedLines = [
    `Mo canh voi ${cleanTopic} trong khong khi hon loan hai huoc.`,
    'Mot tinh tiet bat ngo xuat hien khien moi nguoi dung hinh trong giay lat.',
    'Nhan vat chinh thu mot pha choi lon va that bai ngay lap tuc.',
    'Khung canh xung quanh cang luc cang roi voi nhieu phan ung kho do.',
    'Mot man lat keo bat ngo xuat hien theo cach cuc ky hai.',
    'Canh cuoi ket lai bang mot cu chot meme day kich tinh.',
  ];
  const lines = seedLines
    .slice(0, Math.max(4, Math.min(maxLines, seedLines.length)))
    .map((l) => l.slice(0, lineMaxChars));
  return { title, lines };
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
    const userTopic = prompt.trim().slice(0, SCRIPT_TOPIC_MAX_CHARS);
    const systemPrompt = [
      'Write a funny vertical-video meme script in Vietnamese only.',
      'Return strict JSON only with two keys: title (string) and lines (array of strings).',
      `Rules: title <= 60 chars; ${SCRIPT_MIN_LINES}-${SCRIPT_MAX_LINES} lines; each line <= ${SCRIPT_LINE_MAX_CHARS} chars.`,
      'Target total spoken duration around 30 to 60 seconds.',
      'Lines must be vivid scene descriptions for image generation.',
      'No markdown, no extra keys, no explanation.',
    ].join(' ');

    const modelCandidates = [SCRIPT_MODEL, ...SCRIPT_FALLBACK_MODELS].filter(
      (m, i, arr) => arr.indexOf(m) === i,
    );
    let lastErr = null;
    let text = '';
    let usedModel = '';
    let usage = null;

    for (const modelName of modelCandidates) {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: SCRIPT_MAX_OUTPUT_TOKENS,
          temperature: 0.8,
        },
      });
      for (let attempt = 0; attempt <= SCRIPT_MAX_RETRIES; attempt++) {
        try {
          const result = await model.generateContent(
            `${systemPrompt}\nUser topic: ${userTopic}`,
          );
          text = result.response.text();
          usedModel = modelName;
          usage = normalizeUsage(result?.response?.usageMetadata);
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
      console.error('[generate-video] non-JSON model output', {
        model: usedModel || SCRIPT_MODEL,
        preview: String(text || '').slice(0, 300),
      });
      parsed = tryRecoverScript(text);
      if (!parsed) {
        // Last attempt: ask Gemini to reformat its own output to strict JSON.
        try {
          const repaired = await repairScriptJson({
            genAIClient: genAI,
            modelName: usedModel || SCRIPT_MODEL,
            rawText: text,
          });
          try {
            parsed = JSON.parse(extractJson(repaired));
          } catch {
            parsed = tryRecoverScript(repaired);
          }
        } catch {
          console.error('[generate-video] repair failed', {
            model: usedModel || SCRIPT_MODEL,
          });
          parsed = null;
        }
      }
    }

    const parsedObj = parsed && typeof parsed === 'object' ? parsed : {};
    const title = typeof parsedObj.title === 'string' ? parsedObj.title.trim() : '';
    const lines =
      Array.isArray(parsedObj.lines) && parsedObj.lines.length
        ? parsedObj.lines
            .map((l) => String(l || '').trim())
            .filter((l) => l.length > 0)
            .slice(0, SCRIPT_MAX_LINES)
            .map((l) => l.slice(0, SCRIPT_LINE_MAX_CHARS))
        : [];

    if (!title || !lines.length) {
      console.error('[generate-video] unusable parsed script', {
        model: usedModel || SCRIPT_MODEL,
        titleLength: title.length,
        lineCount: lines.length,
      });
      const fallback = buildFallbackScript(userTopic, SCRIPT_MAX_LINES, SCRIPT_LINE_MAX_CHARS);
      return res.json({
        title: fallback.title,
        lines: fallback.lines,
        modelUsed: usedModel || SCRIPT_MODEL,
        usage,
        fallbackUsed: true,
      });
    }

    if (usage) {
      console.log('[Gemini script usage]', {
        model: usedModel || SCRIPT_MODEL,
        ...usage,
      });
    }

    res.json({
      title,
      lines,
      modelUsed: usedModel || SCRIPT_MODEL,
      usage,
    });
  } catch (err) {
    console.error('Gemini script error:', err);
    const msg = err.message || 'Script generation failed';
    const isQuotaLimit =
      msg.toLowerCase().includes('429') ||
      msg.toLowerCase().includes('quota') ||
      msg.toLowerCase().includes('too many requests');
    if (isQuotaLimit) {
      const userTopic = String(req.body?.prompt || '').trim().slice(0, SCRIPT_TOPIC_MAX_CHARS);
      const fallback = buildFallbackScript(userTopic, SCRIPT_MAX_LINES, SCRIPT_LINE_MAX_CHARS);
      return res.json({
        title: fallback.title,
        lines: fallback.lines,
        modelUsed: SCRIPT_MODEL,
        usage: null,
        fallbackUsed: true,
        warning: 'Gemini quota reached; used local fallback script.',
      });
    }
    const status = msg.toLowerCase().includes('api key') ? 401 : 502;
    res.status(status).json({ error: msg });
  }
});

export { router as videoRouter };
