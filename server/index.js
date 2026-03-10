import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { geminiImageRouter } from './routes/gemini-image.js';
import { videoRouter } from './routes/video.js';
import { youtubeRouter } from './routes/youtube.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../dist')));

app.use('/api/generate-image', geminiImageRouter);
app.use('/api/generate-video', videoRouter);
app.use('/api/youtube', youtubeRouter);

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
