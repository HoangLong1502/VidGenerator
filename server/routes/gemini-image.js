import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = Router();
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-exp';

router.post('/', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt' });
  }
  if (!genAI) {
    return res.status(503).json({
      error: 'Image generation not configured. Set GEMINI_API_KEY in .env (get free key at https://aistudio.google.com/apikey)',
    });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: IMAGE_MODEL,
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const response = result.response;
    if (!response.candidates?.length) {
      return res.status(502).json({ error: 'No response from Gemini' });
    }

    const parts = response.candidates[0].content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const b64 = part.inlineData.data;
        const mime = part.inlineData.mimeType || 'image/png';
        return res.json({ imageBase64: b64, mimeType: mime });
      }
    }

    // If model didn't return image (e.g. text-only model), try Imagen via same SDK if available
    return res.status(502).json({
      error: 'This Gemini model did not return an image. Use Gemini 2.0 Flash with image generation (or set GEMINI_IMAGE_MODEL). See README for API key and model setup.',
    });
  } catch (err) {
    console.error('Gemini image error:', err.message);
    const msg = err.message || 'Image generation failed';
    const status = err.message?.includes('API key') ? 401 : 502;
    return res.status(status).json({ error: msg });
  }
});

export { router as geminiImageRouter };
