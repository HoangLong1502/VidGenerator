import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

const TOKENS_PATH = path.join(__dirname, '../tokens-tiktok.json');
const PKCE_STORE_PATH = path.join(__dirname, '../tiktok-pkce.json');
const SCOPE = 'video.upload,user.info.basic';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PKCE_TTL_MS = 10 * 60 * 1000; // 10 min

function loadPkceStore() {
  try {
    const data = fs.readFileSync(PKCE_STORE_PATH, 'utf8');
    const store = JSON.parse(data);
    const now = Date.now();
    for (const k of Object.keys(store)) {
      if (now - (store[k].created_at || 0) > PKCE_TTL_MS) delete store[k];
    }
    return store;
  } catch {
    return {};
  }
}

function savePkceStore(store) {
  fs.writeFileSync(PKCE_STORE_PATH, JSON.stringify(store, null, 0), 'utf8');
}

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB max TikTok

function getClientKey() {
  return (process.env.TIKTOK_CLIENT_KEY || '').trim();
}
function getClientSecret() {
  return (process.env.TIKTOK_CLIENT_SECRET || '').trim();
}

function getRedirectUri() {
  const port = process.env.PORT || 3001;
  const uri = (process.env.TIKTOK_REDIRECT_URI || '').trim() || `http://localhost:${port}/api/tiktok/oauth2callback`;
  return uri;
}

function loadTokens() {
  try {
    const data = fs.readFileSync(TOKENS_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
}

async function refreshAccessToken(refreshToken) {
  const clientKey = getClientKey();
  const clientSecret = getClientSecret();
  if (!clientKey || !clientSecret) return null;
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: body.toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (data.access_token) {
    saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_in: data.expires_in,
      refresh_expires_in: data.refresh_expires_in,
      open_id: data.open_id,
    });
    return data.access_token;
  }
  return null;
}

function getValidAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.access_token) return null;
  const expiresAt = tokens.expires_at;
  if (expiresAt && Date.now() >= expiresAt - 60000) {
    return refreshAccessToken(tokens.refresh_token);
  }
  return Promise.resolve(tokens.access_token);
}

// Debug: check config (redirect_uri must match TikTok Developer Portal exactly)
router.get('/check-config', (req, res) => {
  const clientKey = getClientKey();
  const clientSecret = getClientSecret();
  res.json({
    client_key_set: !!clientKey,
    client_secret_set: !!clientSecret,
    redirect_uri: getRedirectUri(),
    hint: 'In TikTok Developer Portal: add Login Kit, add this exact Redirect URI. If TikTok requires HTTPS, use ngrok and set TIKTOK_REDIRECT_URI in .env.',
  });
});

// Auth URL for user to connect TikTok (with PKCE)
router.get('/auth-url', (req, res) => {
  const clientKey = getClientKey();
  if (!clientKey) {
    return res.status(503).json({
      error: 'TikTok not configured. Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in .env.',
    });
  }
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  const store = loadPkceStore();
  store[state] = { code_verifier: codeVerifier, created_at: Date.now() };
  savePkceStore(store);
  const params = new URLSearchParams({
    client_key: clientKey,
    scope: SCOPE,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const url = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  res.json({ url });
});

// OAuth2 callback
router.get('/oauth2callback', async (req, res) => {
  const { code, state } = req.query;
  const clientKey = getClientKey();
  const clientSecret = getClientSecret();
  if (!clientKey || !clientSecret || !code) {
    return res.redirect(`${FRONTEND_ORIGIN}/?tiktok=error`);
  }
  const store = loadPkceStore();
  const codeVerifier = store[state]?.code_verifier;
  if (state) delete store[state];
  savePkceStore(store);
  if (!codeVerifier) {
    console.error('TikTok PKCE: missing code_verifier for state');
    return res.redirect(`${FRONTEND_ORIGIN}/?tiktok=error`);
  }
  try {
    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code: String(code),
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(),
      code_verifier: codeVerifier,
    });
    const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: body.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.access_token) {
      console.error('TikTok token error', data);
      return res.redirect(`${FRONTEND_ORIGIN}/?tiktok=error`);
    }
    saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      expires_at: Date.now() + (data.expires_in || 86400) * 1000,
      refresh_expires_in: data.refresh_expires_in,
      open_id: data.open_id,
    });
    res.redirect(`${FRONTEND_ORIGIN}/?tiktok=connected`);
  } catch (e) {
    console.error('TikTok OAuth error', e);
    res.redirect(`${FRONTEND_ORIGIN}/?tiktok=error`);
  }
});

// Status
router.get('/status', async (req, res) => {
  if (!getClientKey()) {
    return res.json({ connected: false, reason: 'not_configured' });
  }
  const token = await getValidAccessToken();
  if (!token) {
    const tokens = loadTokens();
    return res.json({ connected: !!tokens, reason: tokens ? 'token_expired' : 'not_signed_in' });
  }
  return res.json({ connected: true });
});

// Upload video to TikTok (inbox – user completes post in TikTok app)
router.post('/upload', upload.single('video'), async (req, res) => {
  const caption = String(req.body?.caption || req.body?.title || 'Generated video').slice(0, 2200);
  const file = req.file;
  if (!file || !file.buffer) {
    return res.status(400).json({ error: 'No video file provided' });
  }

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return res.status(401).json({ error: 'Not connected to TikTok. Connect your account first.' });
  }

  const size = file.buffer.length;
  const totalChunks = Math.ceil(size / CHUNK_SIZE);
  const chunkSize = totalChunks === 1 ? size : CHUNK_SIZE;

  try {
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: size,
          chunk_size: chunkSize,
          total_chunk_count: totalChunks,
        },
      }),
    });
    const initData = await initRes.json().catch(() => ({}));
    if (!initData.data?.upload_url) {
      const errMsg = initData.error?.message || initData.message || initRes.statusText;
      console.error('TikTok init error', initData);
      return res.status(initRes.status || 502).json({ error: errMsg || 'TikTok init failed' });
    }

    const uploadUrl = initData.data.upload_url;
    const mime = file.mimetype || 'video/webm';
    const contentType = ['video/mp4', 'video/webm', 'video/quicktime'].includes(mime) ? mime : 'video/webm';

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, size);
      const chunk = file.buffer.subarray(start, end);
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${start}-${end - 1}/${size}`,
        },
        body: chunk,
      });
      if (!putRes.ok) {
        const errText = await putRes.text();
        console.error('TikTok upload chunk error', putRes.status, errText);
        return res.status(502).json({ error: 'Upload failed', details: errText });
      }
    }

    res.json({
      success: true,
      message: 'Video sent to TikTok. Open the TikTok app and check your inbox to finish posting.',
      publish_id: initData.data.publish_id,
    });
  } catch (err) {
    console.error('TikTok upload error', err);
    res.status(502).json({ error: err.message || 'Upload failed' });
  }
});

export { router as tiktokRouter };
