import { Router } from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import multer from 'multer';
import moment from 'moment';
import cron from 'node-cron';
import { applyShortsMetadata, shortsWatchUrl } from '../../lib/youtubeShorts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

const TOKENS_PATH = path.join(__dirname, '../tokens.json');
const SCHEDULED_PATH = path.join(__dirname, '../scheduled.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'];
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 256 * 1024 * 1024 } }); // 256MB

function resolveVideoMimeType(file) {
  const rawMime = String(file?.mimetype || '').toLowerCase();
  if (rawMime.startsWith('video/')) return rawMime;

  const ext = path.extname(String(file?.originalname || '')).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.m4v') return 'video/x-m4v';
  if (ext === '.mkv') return 'video/x-matroska';

  return 'video/webm';
}

function getOAuth2Client() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/api/youtube/oauth2callback`;
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

function loadScheduled() {
  try {
    const data = fs.readFileSync(SCHEDULED_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveScheduled(scheduled) {
  fs.writeFileSync(SCHEDULED_PATH, JSON.stringify(scheduled, null, 2), 'utf8');
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
    return res.redirect(`${FRONTEND_ORIGIN}/?youtube=error`);
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    saveTokens(tokens);
    res.redirect(`${FRONTEND_ORIGIN}/?youtube=connected`);
  } catch (e) {
    console.error('YouTube OAuth error:', e);
    res.redirect(`${FRONTEND_ORIGIN}/?youtube=error`);
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
  const {
    title = 'Generated Video',
    description = '',
    privacy = 'public',
    publishAt,
    categoryId,
    asShort,
  } = req.body || {};
  const publishAsShort = String(asShort ?? 'true').toLowerCase() !== 'false';
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
    const mimeType = resolveVideoMimeType(file);
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });

    let status = {
      privacyStatus: ['public', 'unlisted', 'private'].includes(privacy) ? privacy : 'public',
    };

    if (publishAt) {
      const publishTime = moment(publishAt);
      if (publishTime.isAfter(moment())) {
        // Schedule for future: upload as private draft
        status.privacyStatus = 'private';
      } else {
        // Publish now
        status.publishAt = publishTime.toISOString();
      }
    }

    const snippet = publishAsShort
      ? applyShortsMetadata({ title, description })
      : {
          title: String(title).slice(0, 100),
          description: String(description).slice(0, 5000),
          tags: [],
        };

    const result = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          ...snippet,
          categoryId: categoryId || '22',
        },
        status,
      },
      media: {
        body: Readable.from(file.buffer),
        mimeType,
      },
    });

    const id = result.data.id;
    const url = publishAsShort ? shortsWatchUrl(id) : `https://www.youtube.com/watch?v=${id}`;

    if (publishAt && moment(publishAt).isAfter(moment())) {
      // Save to scheduled
      const scheduled = loadScheduled();
      scheduled.push({
        videoId: id,
        publishAt: publishAt,
        title,
        description,
        categoryId: categoryId || '22',
      });
      saveScheduled(scheduled);
      res.json({ success: true, videoId: id, url, shorts: publishAsShort, scheduled: true });
    } else {
      res.json({ success: true, videoId: id, url, shorts: publishAsShort });
    }
  } catch (err) {
    console.error('YouTube upload error:', err);
    res.status(502).json({
      error: err.message || 'Upload failed',
      details: err.response?.data?.error?.message,
    });
  }
});

async function publishScheduledVideos() {
  const oauth2 = getOAuth2Client();
  if (!oauth2) return;
  const tokens = loadTokens();
  if (!tokens) return;
  oauth2.setCredentials(tokens);

  const youtube = google.youtube({ version: 'v3', auth: oauth2 });
  const scheduled = loadScheduled();
  const now = moment();
  const toPublish = [];
  const remaining = [];

  for (const item of scheduled) {
    if (moment(item.publishAt).isBefore(now)) {
      toPublish.push(item);
    } else {
      remaining.push(item);
    }
  }

  for (const item of toPublish) {
    try {
      await youtube.videos.update({
        part: ['status', 'snippet'],
        requestBody: {
          id: item.videoId,
          snippet: {
            title: item.title,
            description: item.description,
            categoryId: item.categoryId,
          },
          status: {
            privacyStatus: 'public',
          },
        },
      });
      console.log(`Published scheduled video: ${item.videoId}`);
    } catch (err) {
      console.error(`Failed to publish ${item.videoId}:`, err);
      remaining.push(item); // Retry later
    }
  }

  saveScheduled(remaining);
}

// Schedule cron job to check every minute
cron.schedule('* * * * *', () => {
  publishScheduledVideos();
});

export { router as youtubeRouter };
