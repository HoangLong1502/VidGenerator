/** YouTube classifies Shorts from vertical video + #Shorts in title/description (no API flag). */
export const YOUTUBE_SHORTS_MAX_SEC = Number(process.env.YOUTUBE_SHORTS_MAX_SEC || 60);

export function applyShortsMetadata({ title = '', description = '', tags = [] }) {
  let t = String(title || '').trim();
  let d = String(description || '').trim();
  const tagList = Array.isArray(tags) ? [...tags] : [];
  if (!tagList.some((x) => /^shorts$/i.test(String(x)))) {
    tagList.push('Shorts');
  }

  if (!/#shorts/i.test(d)) {
    d = d ? `${d}\n\n#Shorts` : '#Shorts';
  }
  if (!/#shorts/i.test(t)) {
    const suffix = ' #Shorts';
    t = t.length + suffix.length <= 100 ? `${t}${suffix}` : t;
  }

  return {
    title: t.slice(0, 100),
    description: d.slice(0, 5000),
    tags: tagList.map((x) => String(x).slice(0, 30)).slice(0, 30),
  };
}

export function shortsWatchUrl(videoId) {
  return `https://www.youtube.com/shorts/${videoId}`;
}
