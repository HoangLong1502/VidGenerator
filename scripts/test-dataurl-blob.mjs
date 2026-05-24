function dataUrlToBlob(dataUrl) {
  const s = String(dataUrl || '').trim();
  const m = s.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is);
  if (!m) return null;
  const mime = (m[1] || 'image/jpeg').toLowerCase();
  const b64 = m[2].replace(/\s/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const tiny =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const blob = dataUrlToBlob(tiny);
console.log(blob?.type, blob?.size);
