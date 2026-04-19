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
  process.env.GEMINI_SCRIPT_FALLBACK_MODELS || 'gemini-2.0-flash,gemini-flash-latest',
)
  .split(',')
  .map((m) => normalizeScriptModelName(m))
  .filter(Boolean);
const SCRIPT_MAX_RETRIES = Number(process.env.GEMINI_SCRIPT_MAX_RETRIES || 3);
const SCRIPT_TOPIC_MAX_CHARS = Number(process.env.GEMINI_SCRIPT_TOPIC_MAX_CHARS || 240);
const SCRIPT_MIN_LINES = Number(process.env.GEMINI_SCRIPT_MIN_LINES || 22);
const SCRIPT_MAX_LINES = Number(process.env.GEMINI_SCRIPT_MAX_LINES || 34);
/** Per-line cap after parse (was 96 and truncated mid-sentence). Keep high enough for full Vietnamese sentences. */
const SCRIPT_LINE_MAX_CHARS = Number(process.env.GEMINI_SCRIPT_LINE_MAX_CHARS || 280);
const SCRIPT_MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_SCRIPT_MAX_OUTPUT_TOKENS || 16384);
/** Set to "false" if the API returns 400 (unknown thinkingConfig for your SDK/model). */
const SCRIPT_DISABLE_THINKING =
  String(process.env.GEMINI_SCRIPT_DISABLE_THINKING || 'true').toLowerCase() !== 'false';
const REPAIR_CONTENT_MAX_CHARS = Number(process.env.GEMINI_SCRIPT_REPAIR_CONTENT_MAX || 14000);
const GEMINI_429_MAX_RETRIES = Number(process.env.GEMINI_SCRIPT_429_MAX_RETRIES || 3);
const GEMINI_429_MAX_WAIT_MS = Number(process.env.GEMINI_SCRIPT_429_MAX_WAIT_MS || 48000);

function buildScriptGenerationConfig({ maxOutputTokens, temperature, responseMimeType }) {
  const cfg = {
    maxOutputTokens,
    temperature,
  };
  if (responseMimeType) cfg.responseMimeType = responseMimeType;
  if (SCRIPT_DISABLE_THINKING) {
    cfg.thinkingConfig = { thinkingBudget: 0 };
  }
  return cfg;
}

function isTransientGeminiError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('503') || msg.includes('service unavailable') || msg.includes('high demand') || msg.includes('429');
}

function isGemini429(err) {
  return err?.status === 429 || String(err?.message || '').includes('429');
}

/** Prefer server-provided RetryInfo; cap so one /generate-video does not hang forever. */
function gemini429RetryDelayMs(err) {
  const details = Array.isArray(err?.errorDetails) ? err.errorDetails : [];
  for (const d of details) {
    if (String(d?.['@type'] || '').includes('RetryInfo') && d.retryDelay != null) {
      const sec = Number(String(d.retryDelay).replace(/s$/i, '').trim());
      if (Number.isFinite(sec) && sec > 0) {
        return Math.min(GEMINI_429_MAX_WAIT_MS, Math.max(3000, Math.round(sec * 1000)));
      }
    }
  }
  const fromMsg = String(err?.message || '').match(/retry in ([\d.]+)\s*s/i);
  if (fromMsg) {
    const sec = Number(fromMsg[1]);
    if (Number.isFinite(sec)) {
      return Math.min(GEMINI_429_MAX_WAIT_MS, Math.max(3000, Math.round(sec * 1000)));
    }
  }
  return Math.min(GEMINI_429_MAX_WAIT_MS, 12000);
}

/** Wraps model.generateContent with 429 backoff (free tier often asks for 30–60s). */
async function generateContentWith429Backoff(model, request) {
  let lastErr;
  for (let i = 0; i < GEMINI_429_MAX_RETRIES; i++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await model.generateContent(request);
    } catch (e) {
      lastErr = e;
      if (!isGemini429(e) || i === GEMINI_429_MAX_RETRIES - 1) throw e;
      const delayMs = gemini429RetryDelayMs(e);
      console.warn(
        `[generate-video] Gemini 429, waiting ${delayMs}ms before retry ${i + 1}/${GEMINI_429_MAX_RETRIES}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
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

  // Attempt 0b: escaped JSON strings in lines (handles `\"`); still useful when 0's simpler regex misses.
  if (titleFromJson && linesBlock) {
    const escapedLineRe = /"((?:\\.|[^"\\])*)"/g;
    const recovered = [];
    let m;
    while ((m = escapedLineRe.exec(linesBlock)) !== null) {
      const s = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
      if (s) recovered.push(s);
    }
    if (recovered.length) {
      return { title: titleFromJson, lines: recovered };
    }
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

function extractTitleFromPartialRaw(rawText) {
  const m = String(rawText || '').match(/"title"\s*:\s*"([^"]*)"/i);
  return m?.[1]?.trim() || '';
}

/**
 * When the main response is truncated after title (no "lines" array), ask for lines only.
 * Smaller JSON payload = far less likely to hit output limits than title+lines together.
 */
async function generateLinesOnlyScript({ genAIClient, modelName, title, userTopic }) {
  const safeTitle = String(title || '').trim().slice(0, 120);
  const safeTopic = String(userTopic || '').trim().slice(0, SCRIPT_TOPIC_MAX_CHARS);
  if (!safeTitle || !safeTopic) return [];

  const model = genAIClient.getGenerativeModel({
    model: modelName,
    generationConfig: buildScriptGenerationConfig({
      maxOutputTokens: SCRIPT_MAX_OUTPUT_TOKENS,
      temperature: 0.45,
      responseMimeType: 'application/json',
    }),
  });

  const prompt = [
    'You continue a vertical meme video script in Vietnamese only.',
    'Use correct Vietnamese orthography with full diacritics on every word.',
    `The title is already fixed as: "${safeTitle}".`,
    `User topic (for context): ${safeTopic}`,
    'Return strict JSON only with a single key "lines" (array of strings).',
    `You MUST output at least ${SCRIPT_MIN_LINES} and at most ${SCRIPT_MAX_LINES} lines.`,
    `Each line <= ${SCRIPT_LINE_MAX_CHARS} characters.`,
    'Together, lines must be long enough that spoken TTS lasts at least 90 seconds (1m30s); use full sentences per line.',
    'Each array item must be one or more complete Vietnamese sentences ending with . ! or ?; never truncate mid-sentence.',
    'Each line is a vivid scene description for image generation, natural when read aloud.',
    'No title field, no markdown, no extra keys.',
  ].join(' ');

  const result = await generateContentWith429Backoff(model, prompt);
  const raw = result.response.text?.() || '';
  let lines = [];
  try {
    const o = JSON.parse(extractJson(raw));
    if (Array.isArray(o.lines)) {
      lines = o.lines;
    }
  } catch {
    lines = [];
  }
  if (!lines.length) {
    lines = tryRecoverLinesArrayOnly(raw);
  }
  return lines
    .map((l) => String(l || '').trim())
    .filter((l) => l.length > 0)
    .slice(0, SCRIPT_MAX_LINES)
    .map((l) => l.slice(0, SCRIPT_LINE_MAX_CHARS));
}

/** Pull string elements from a blob that is mostly a JSON "lines" array. */
function tryRecoverLinesArrayOnly(rawText) {
  const raw = String(rawText || '').trim();
  const start = raw.indexOf('[');
  if (start < 0) return [];
  const inner = raw.slice(start + 1);
  const escapedLineRe = /"((?:\\.|[^"\\])*)"/g;
  const out = [];
  let m;
  while ((m = escapedLineRe.exec(inner)) !== null) {
    const s = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
    if (s) out.push(s);
  }
  return out;
}

async function repairScriptJson({ genAIClient, modelName, rawText }) {
  const model = genAIClient.getGenerativeModel({
    model: modelName,
    generationConfig: buildScriptGenerationConfig({
      maxOutputTokens: Math.min(8192, SCRIPT_MAX_OUTPUT_TOKENS),
      temperature: 0.1,
      responseMimeType: 'application/json',
    }),
  });

  const clipped = String(rawText || '').slice(0, REPAIR_CONTENT_MAX_CHARS);
  const repairPrompt = [
    'Convert the following content to strict JSON only.',
    'Output format: {"title":"...","lines":["..."]}',
    'Vietnamese strings must keep full diacritics (đủ dấu).',
    'No markdown. No explanation. No extra keys.',
    'If content is unusable, return {"title":"","lines":[]}.',
    '',
    'CONTENT:',
    clipped,
  ].join('\n');

  const result = await generateContentWith429Backoff(model, repairPrompt);
  const repaired = result?.response?.text?.() || '';
  return extractJson(repaired);
}

/** Parse model output into title + lines (heuristics; lines-only before heavy repair to save quota). */
async function parseScriptWithRecovery(rawText, genAIClient, modelName, userTopic) {
  let parsed = null;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch {
    console.error('[generate-video] non-JSON model output', {
      model: modelName,
      preview: String(rawText || '').slice(0, 300),
    });
    parsed = tryRecoverScript(rawText);
  }

  let parsedObj = parsed && typeof parsed === 'object' ? parsed : {};
  let title = typeof parsedObj.title === 'string' ? parsedObj.title.trim() : '';
  let lines =
    Array.isArray(parsedObj.lines) && parsedObj.lines.length
      ? parsedObj.lines
          .map((l) => String(l || '').trim())
          .filter((l) => l.length > 0)
          .slice(0, SCRIPT_MAX_LINES)
          .map((l) => l.slice(0, SCRIPT_LINE_MAX_CHARS))
      : [];

  if (!title && rawText) {
    title = extractTitleFromPartialRaw(rawText);
  }

  if (title && !lines.length && genAIClient && modelName && userTopic) {
    try {
      console.warn('[generate-video] lines missing; requesting lines-only (before repair)');
      lines = await generateLinesOnlyScript({
        genAIClient,
        modelName,
        title,
        userTopic,
      });
    } catch (e) {
      if (e?.status === 429 || String(e?.message || '').includes('429')) throw e;
      console.error('[generate-video] lines-only (pre-repair) failed', e);
    }
  }

  if (!lines.length && rawText && genAIClient && modelName) {
    try {
      const repaired = await repairScriptJson({
        genAIClient,
        modelName,
        rawText,
      });
      try {
        parsed = JSON.parse(extractJson(repaired));
      } catch {
        parsed = tryRecoverScript(repaired);
      }
      parsedObj = parsed && typeof parsed === 'object' ? parsed : {};
      const t2 = typeof parsedObj.title === 'string' ? parsedObj.title.trim() : '';
      const l2 =
        Array.isArray(parsedObj.lines) && parsedObj.lines.length
          ? parsedObj.lines
              .map((l) => String(l || '').trim())
              .filter((l) => l.length > 0)
              .slice(0, SCRIPT_MAX_LINES)
              .map((l) => l.slice(0, SCRIPT_LINE_MAX_CHARS))
          : [];
      if (l2.length) {
        lines = l2;
        if (t2) title = t2;
      }
    } catch (e) {
      if (e?.status === 429 || String(e?.message || '').includes('429')) throw e;
      console.error('[generate-video] repair failed', { model: modelName });
    }
  }

  if (title && !lines.length && genAIClient && modelName && userTopic) {
    try {
      console.warn('[generate-video] lines still missing; lines-only after repair');
      lines = await generateLinesOnlyScript({
        genAIClient,
        modelName,
        title,
        userTopic,
      });
    } catch (e) {
      if (e?.status === 429 || String(e?.message || '').includes('429')) throw e;
      console.error('[generate-video] lines-only (post-repair) failed', e);
    }
  }

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
      'Use correct Vietnamese orthography: full tone marks and vowel marks on every word (đủ dấu thanh và dấu mũ); never output accent-stripped or ASCII-only Vietnamese.',
      'Return strict JSON only with two keys: title (string) and lines (array of strings).',
      `Rules: title <= 60 chars; you MUST output at least ${SCRIPT_MIN_LINES} lines and at most ${SCRIPT_MAX_LINES} lines; each line <= ${SCRIPT_LINE_MAX_CHARS} characters (complete thoughts, not truncated).`,
      'Each lines[] entry must be one or more complete Vietnamese sentences (finish with . ! or ?); never end a line mid-sentence; do not shorten lines artificially to fit a length limit.',
      'Target total spoken narration at least 90 seconds (2 minutes 30 seconds); prefer roughly 150–250 seconds when read aloud: write fuller sentences per line, not one-word punchlines.',
      'Lines must be vivid scene descriptions for image generation and sound natural when read aloud.',
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
        generationConfig: buildScriptGenerationConfig({
          maxOutputTokens: SCRIPT_MAX_OUTPUT_TOKENS,
          temperature: 0.8,
          responseMimeType: 'application/json',
        }),
      });
      for (let attempt = 0; attempt <= SCRIPT_MAX_RETRIES; attempt++) {
        try {
          const result = await generateContentWith429Backoff(
            model,
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
          const delayMs = isGemini429(e) ? gemini429RetryDelayMs(e) : 1200 * (attempt + 1);
          // Backoff for temporary load spikes (429 often needs tens of seconds on free tier).
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      if (!lastErr && text) break;
    }

    if (lastErr && !text) throw lastErr;

    let modelNameUsed = usedModel || SCRIPT_MODEL;
    let { title, lines } = await parseScriptWithRecovery(text, genAI, modelNameUsed, userTopic);

    if ((!title || !lines.length) && modelCandidates.length > 1) {
      const altName = modelCandidates.find((m) => m !== modelNameUsed);
      if (altName) {
        console.warn('[generate-video] invalid/truncated script; regenerating with model', altName);
        try {
          const altGen = genAI.getGenerativeModel({
            model: altName,
            generationConfig: buildScriptGenerationConfig({
              maxOutputTokens: SCRIPT_MAX_OUTPUT_TOKENS,
              temperature: 0.65,
              responseMimeType: 'application/json',
            }),
          });
          const rAlt = await generateContentWith429Backoff(
            altGen,
            `${systemPrompt}\nUser topic: ${userTopic}`,
          );
          text = rAlt.response.text();
          usedModel = altName;
          modelNameUsed = altName;
          usage = normalizeUsage(rAlt?.response?.usageMetadata);
          const pAlt = await parseScriptWithRecovery(text, genAI, modelNameUsed, userTopic);
          title = pAlt.title;
          lines = pAlt.lines;
        } catch (e) {
          if (e?.status === 429 || String(e?.message || '').includes('429')) throw e;
          console.warn('[generate-video] alternate model regenerate failed', e);
        }
      }
    }

    if (!title || !lines.length) {
      console.warn('[generate-video] strict JSON-only AI retry');
      try {
        const strictModel = genAI.getGenerativeModel({
          model: modelNameUsed,
          generationConfig: buildScriptGenerationConfig({
            maxOutputTokens: SCRIPT_MAX_OUTPUT_TOKENS,
            temperature: 0.15,
            responseMimeType: 'application/json',
          }),
        });
        const strictTail = [
          'Reply with a single JSON object only.',
          'Do not wrap in markdown code fences.',
          'Do not print any text before the first { or after the last }.',
          `User topic: ${userTopic}`,
        ].join(' ');
        const r2 = await generateContentWith429Backoff(strictModel, `${systemPrompt}\n${strictTail}`);
        const text2 = r2.response.text();
        const u2 = normalizeUsage(r2?.response?.usageMetadata);
        const second = await parseScriptWithRecovery(text2, genAI, modelNameUsed, userTopic);
        title = second.title;
        lines = second.lines;
        if (title && lines.length && u2) usage = u2;
      } catch (e) {
        console.error('[generate-video] strict retry failed', e);
      }
    }

    if (!title || !lines.length) {
      console.error('[generate-video] unusable parsed script after AI retry', {
        model: modelNameUsed,
        titleLength: title.length,
        lineCount: lines.length,
      });
      return res.status(502).json({
        error:
          'AI did not return a usable script (missing title or lines). If you hit Gemini free-tier limits, wait a minute and retry, set GEMINI_SCRIPT_FALLBACK_MODELS to another model (e.g. gemini-2.0-flash), or shorten the topic.',
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
      err?.status === 429 ||
      msg.toLowerCase().includes('429') ||
      msg.toLowerCase().includes('quota') ||
      msg.toLowerCase().includes('too many requests');
    if (isQuotaLimit) {
      const retryAfterSeconds = Math.min(
        120,
        Math.max(15, Math.ceil(gemini429RetryDelayMs(err) / 1000)),
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error:
          'Gemini quota or rate limit (free tier is strict). The server already retried with backoff; wait 1–2 minutes, reduce how often you click Generate, set GEMINI_SCRIPT_FALLBACK_MODELS to another model, or enable billing. See https://ai.google.dev/gemini-api/docs/rate-limits',
        retryAfterSeconds,
        docsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
      });
    }
    const status = msg.toLowerCase().includes('api key') ? 401 : 502;
    res.status(status).json({ error: msg });
  }
});

export { router as videoRouter };
