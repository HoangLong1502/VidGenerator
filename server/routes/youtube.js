import { Router } from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

const TOKENS_PATH = path.join(__dirname, '../tokens.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'];

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 256 * 1024 * 1024 } }); // 256MB

function getOAuth2Client() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/api/youtube/oauth2callback`;
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
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

// Get auth URL for user to sign in
router.get('/auth-url', (req, res) => {
  const oauth2 = getOAuth2Client();
  if (!oauth2) {
    return res.status(503).json({
      error: 'YouTube not configured. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env. See README.',
    });
  }
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.json({ url });
});

// OAuth2 callback - exchange code for tokens
router.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  const oauth2 = getOAuth2Client();
  if (!oauth2 || !code) {
    return res.redirect(`${frontendOrigin}/?youtube=error`);
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    saveTokens(tokens);
    res.redirect(`${frontendOrigin}/?youtube=connected`);
  } catch (e) {
    console.error('YouTube OAuth error:', e);
    res.redirect(`${frontendOrigin}/?youtube=error`);
  }
});

// Check if we have valid tokens
router.get('/status', async (req, res) => {
  const oauth2 = getOAuth2Client();
  if (!oauth2) return res.json({ connected: false, reason: 'not_configured' });
  const tokens = loadTokens();
  if (!tokens) return res.json({ connected: false, reason: 'not_signed_in' });
  oauth2.setCredentials(tokens);
  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });
    await youtube.channels.list({ part: 'snippet', mine: true });
    return res.json({ connected: true });
  } catch (e) {
    return res.json({ connected: false, reason: 'token_invalid' });
  }
});

// Upload video to YouTube
router.post('/upload', upload.single('video'), async (req, res) => {
  const { title = 'Generated Video', description = '', privacy = 'public' } = req.body || {};
  const file = req.file;
  if (!file || !file.buffer) {
    return res.status(400).json({ error: 'No video file provided' });
  }

  const oauth2 = getOAuth2Client();
  if (!oauth2) {
    return res.status(503).json({ error: 'YouTube not configured' });
  }
  const tokens = loadTokens();
  if (!tokens) {
    return res.status(401).json({ error: 'Not signed in to YouTube. Open the auth URL first.' });
  }
  oauth2.setCredentials(tokens);

  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });
    const result = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: String(title).slice(0, 100),
          description: String(description).slice(0, 5000),
        },
        status: {
          privacyStatus: ['public', 'unlisted', 'private'].includes(privacy) ? privacy : 'public',
        },
      },
      media: {
        body: Readable.from(file.buffer),
        mimeType: file.mimetype || 'video/webm',
      },
    });
    const id = result.data.id;
    const url = `https://www.youtube.com/watch?v=${id}`;
    res.json({ success: true, videoId: id, url });
  } catch (err) {
    console.error('YouTube upload error:', err);
    res.status(502).json({
      error: err.message || 'Upload failed',
      details: err.response?.data?.error?.message,
    });
  }
});

export { router as youtubeRouter };
