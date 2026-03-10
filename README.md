<<<<<<< HEAD
# VidGenerator
=======
# Prompt → Video → YouTube

Create images from text using **Google Gemini** (free tier), turn them into short videos in the browser, then **publish to your YouTube channel** with one click.

## What you need

1. **Gemini API key** (free) – [Get one at Google AI Studio](https://aistudio.google.com/apikey).
2. **YouTube OAuth** – A Google Cloud project with YouTube Data API v3 and OAuth 2.0 credentials (see below).

## Quick start

```bash
npm install
cp .env.example .env
# Edit .env: add GEMINI_API_KEY and (optional) YouTube credentials
npm run dev
```

- **App:** http://localhost:5173  
- **API:** http://localhost:3001  

Use the app at 5173; it proxies `/api` to the server. If you see a connection error on first load, wait a second for the server to start and refresh.

## Setup

### 1. Gemini (image generation)

- Go to [Google AI Studio](https://aistudio.google.com/apikey) and create an API key.
- Put it in `.env` as `GEMINI_API_KEY=...`.

The app uses the Gemini 2.0 Flash experimental model with image generation. If your key or region doesn’t support it, set `GEMINI_IMAGE_MODEL` in `.env` to another model that supports images (see [Google’s docs](https://ai.google.dev/gemini-api/docs/image-generation)).

### 2. YouTube (publish)

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. **Enable** [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
4. Go to **APIs & Services → Credentials** and create **OAuth 2.0 Client ID** (Web application).
5. Under **Authorized redirect URIs** add:
   - `http://localhost:3001/api/youtube/oauth2callback` (for local dev)
   - Your production callback URL if you deploy (e.g. `https://yourdomain.com/api/youtube/oauth2callback`).
6. Copy **Client ID** and **Client secret** into `.env`:
   - `YOUTUBE_CLIENT_ID=...`
   - `YOUTUBE_CLIENT_SECRET=...`

In the app, click **Connect YouTube account**, sign in in the popup, then use **Publish to YouTube** to upload.

## Flow

1. **Prompt** – Type a description (e.g. “A serene mountain lake at sunset”).
2. **Generate image** – Calls Gemini and shows the image.
3. **Create video from image** – Builds a short (5s) video from that image in the browser.
4. **Publish to YouTube** – Connect your channel once, then upload the video with title, description, and privacy (public/unlisted/private).

## Production

```bash
npm run build
PORT=3001 node server/index.js
```

Serve the app from the same origin as the API (e.g. reverse proxy to `server` and `/api`). Set `YOUTUBE_REDIRECT_URI` in `.env` to your real callback URL.

## Optional: AI-generated video

Right now, “video” is created from the generated image in the browser. To use an external **text-to-video** API (e.g. Replicate), add your token to `.env` as `REPLICATE_API_TOKEN` and implement the call in `server/routes/video.js` (the route is prepared for that).
>>>>>>> 70a6389 (Initial VidGenerator app)
