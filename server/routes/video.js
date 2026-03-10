import { Router } from 'express';

const router = Router();

// Video is created in the frontend from the generated image (canvas + MediaRecorder).
// This endpoint can be used later to call Replicate/Wan/etc. if you add REPLICATE_API_TOKEN.
router.post('/', async (req, res) => {
  const { prompt, imageBase64 } = req.body || {};
  if (!prompt && !imageBase64) {
    return res.status(400).json({ error: 'Provide prompt (for new image) or imageBase64 (to make video from existing image)' });
  }
  // If you set REPLICATE_API_TOKEN, we could call a model here. For now return instructions.
  if (!process.env.REPLICATE_API_TOKEN) {
    return res.json({
      useClientVideo: true,
      message: 'Create video from your image in the app (click "Create video from image"). For AI-generated video from text, add REPLICATE_API_TOKEN and a video model in server/routes/video.js.',
    });
  }
  // Placeholder for Replicate video generation - user can add their key and implement.
  res.json({ useClientVideo: true, message: 'Video from image is built in the app.' });
});

export { router as videoRouter };
