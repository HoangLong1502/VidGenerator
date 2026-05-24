# Run Project Guide (NPM + TTS + A1111)

This guide helps you run the full project locally with:
- Main app/API (`npm run dev`)
- TTS server (Edge TTS)
- Automatic1111 (A1111) for free local image generation

---

## 1) Prerequisites

- Windows 10/11
- Node.js 18+ and npm
- Python (for TTS and A1111)
- Git

Optional but recommended:
- NVIDIA GPU (faster A1111 generation)

---

## 2) Configure `.env`

In the project root (`F:\VidGenerator`), make sure your `.env` has these important values:

```env
GEMINI_API_KEY=your_key_here
GEMINI_SCRIPT_MODEL=gemini-flash-latest

IMAGE_PROVIDER=a1111
SD_API_URL=http://127.0.0.1:7860
SD_WIDTH=576
SD_HEIGHT=1024
SD_STEPS=28
SD_CFG_SCALE=7
MAX_BG_IMAGES=34
IMAGE_STYLE_PRESET=digital_art

PORT=3001
```

Notes:
- `GEMINI_API_KEY` is used for script generation (title + lines).
- Image generation is local via A1111 (`IMAGE_PROVIDER=a1111`).

---

## 3) Start A1111 (image generator)

In a new terminal:

```powershell
cd "F:\AI\stable-diffusion-webui"
.\webui-user.bat
```

Wait until you see:

```text
Running on local URL:  http://127.0.0.1:7860
```

Keep this terminal open.

Quick check:
- Open `http://127.0.0.1:7860` in browser.

---

## 4) Start TTS server

In another terminal:

```powershell
cd "F:\coqui-tts-server"
.\.venv\Scripts\activate
uvicorn server:app --host 127.0.0.1 --port 8001
```

Keep this terminal open.

---

## 5) Start VidGenerator (frontend + backend)

In another terminal:

```powershell
cd "F:\VidGenerator"
npm install
npm run dev
```

You should see:
- API server on `http://localhost:3001`
- Vite frontend on `http://localhost:5173` (or another 517x port if busy)

Open the frontend URL from terminal output.

---

## 6) Use the app

1. Enter prompt.
2. Click **Generate video**.
3. Flow:
   - Gemini creates story script (`title + lines`).
   - Backend calls A1111 to generate digital-art scene images.
   - Frontend renders images + text + TTS into video preview.

---

## 7) Health checks

### API health
`http://localhost:3001/api/health` should return:

```json
{"ok":true}
```

### A1111 reachable
- `http://127.0.0.1:7860` should open successfully.

### TTS reachable
- App should not show TTS connection error.
- If needed, check TTS terminal logs when generating.

---

## 8) Common issues and fixes

### A) `/api/generate-images` returns 502

Check:
- A1111 is running (`127.0.0.1:7860` works)
- `.env` has `IMAGE_PROVIDER=a1111`
- Restart `npm run dev` after `.env` changes

---

### B) A1111 startup fails with `pkg_resources` / CLIP errors

In `F:\AI\stable-diffusion-webui`:

```powershell
.\venv\Scripts\python.exe -m pip install --force-reinstall "setuptools==65.5.1"
.\venv\Scripts\python.exe -m pip install "https://github.com/openai/CLIP/archive/d50d76daa670286dd6cacf3bcd80b5e4823fc8e1.zip" --prefer-binary --no-build-isolation
```

Then run:

```powershell
.\webui-user.bat
```

---

### C) A1111 clone error for `Stability-AI/stablediffusion.git`

Set this in `webui-user.bat`:

```bat
set STABLE_DIFFUSION_REPO=https://github.com/w-e-w/stablediffusion.git
```

Then run A1111 again.

---

### D) Network tab spam requests to random lambda URL

Those requests are usually browser extensions, not this app.
Test in Incognito (extensions off) to confirm.

---

## 9) Stop services

- `Ctrl + C` in each terminal:
  - A1111 terminal
  - TTS terminal
  - `npm run dev` terminal

