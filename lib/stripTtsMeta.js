/**
 * Strip stage-direction prefixes so TTS does not read labels like
 * "cảnh tiếp theo", "cảnh mở đầu", "giọng đọc", etc.
 */

const SCENE_LABEL_WORDS =
  '(?:\\d+|mở\\s*đầu|kết(?:\\s*thúc)?|tiếp\\s*theo|cuối(?:\\s*cùng)?|đầu|giữa|phụ|chính)';

const SCENE_PREFIX_RE = new RegExp(
  `^\\s*(?:(?:\\[|\\()\\s*)?(?:cảnh|canh|scene)\\s*${SCENE_LABEL_WORDS}(?:\\s*[-:.|]\\s*)?\\s*[,;:]?\\s*`,
  'iu',
);

const NARRATOR_PREFIX_RE =
  /^\s*(?:(?:\[|\()?\s*(?:giọng\s*đọc|giong\s*doc|lời\s*dẫn|loi\s*dan|thuyết\s*minh|narrator|voice\s*over|voiceover|vo)\s*[:.\-–—]?\s*)/iu;

/** @param {string} text */
export function stripTtsMetaLine(text) {
  let s = String(text || '')
    .replace(/^\s*[*#_]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';

  for (let i = 0; i < 5; i++) {
    const prev = s;
    s = s
      .replace(SCENE_PREFIX_RE, '')
      .replace(NARRATOR_PREFIX_RE, '')
      .replace(/^\s*[\])]\s*/, '')
      .replace(/^\s*[-–—,:;|]+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (s === prev) break;
  }

  return s;
}

/** @param {string[]} segments */
export function stripTtsMetaSegments(segments) {
  return segments.map(stripTtsMetaLine).filter((s) => s.length > 0);
}
