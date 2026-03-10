const promptEl = document.getElementById('prompt');
const btnVideo = document.getElementById('btn-video');
const messageEl = document.getElementById('message');
const previewPlaceholder = document.getElementById('preview-placeholder');
const previewImg = document.getElementById('preview-img');
const previewVideo = document.getElementById('preview-video');
const youtubeStatus = document.getElementById('youtube-status');
const btnConnectYt = document.getElementById('btn-connect-yt');
const publishForm = document.getElementById('publish-form');
const ytTitle = document.getElementById('yt-title');
const ytDesc = document.getElementById('yt-desc');
const ytPrivacy = document.getElementById('yt-privacy');
const btnPublish = document.getElementById('btn-publish');

let currentVideoBlob = null;
const VIDEO_DURATION_MS = 5000;

function showMessage(text, type = 'info') {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  messageEl.classList.remove('hidden');
}

function hideMessage() {
  messageEl.classList.add('hidden');
}

function setLoading(button, loading) {
  button.disabled = loading;
  button.textContent = loading ? '…' : button.dataset.label || button.textContent;
}

function makeVideoFromImageBase64(imageBase64, mimeType = 'image/png') {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      const stream = canvas.captureStream(15);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 2500000 });
      const chunks = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: 'video/webm' }));
      };
      recorder.onerror = () => reject(new Error('Recording failed'));
      const draw = () => {
        ctx.drawImage(img, 0, 0);
        requestAnimationFrame(draw);
      };
      draw();
      recorder.start(100);
      setTimeout(() => recorder.stop(), VIDEO_DURATION_MS);
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = `data:${mimeType};base64,${imageBase64}`;
  });
}

async function generateVideo() {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    showMessage('Enter a prompt first.', 'error');
    return;
  }
  btnVideo.dataset.label = 'Generate video';
  setLoading(btnVideo, true);
  hideMessage();
  previewImg.classList.add('hidden');
  previewVideo.classList.add('hidden');
  previewPlaceholder.classList.remove('hidden');
  previewPlaceholder.textContent = 'Generating image…';

  try {
    const res = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
    if (!data.imageBase64) throw new Error('No image in response');

    previewPlaceholder.textContent = 'Creating video…';
    currentVideoBlob = await makeVideoFromImageBase64(data.imageBase64, data.mimeType || 'image/png');

    previewVideo.src = URL.createObjectURL(currentVideoBlob);
    previewVideo.classList.remove('hidden');
    previewImg.classList.add('hidden');
    previewPlaceholder.classList.add('hidden');
    showMessage('Video ready. Connect YouTube and click "Publish to YouTube" to upload.', 'success');
  } catch (e) {
    showMessage(e.message || 'Video generation failed', 'error');
    previewPlaceholder.textContent = 'Your video will appear here.';
  } finally {
    setLoading(btnVideo, false);
  }
}

async function checkYoutubeStatus(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('/api/youtube/status');
      const data = await res.json();
      if (data.connected) {
        youtubeStatus.textContent = 'Connected to YouTube';
        youtubeStatus.className = 'youtube-status connected';
        publishForm.classList.remove('hidden');
      } else {
        youtubeStatus.textContent = data.reason === 'not_configured' ? 'YouTube not configured (see .env)' : 'Not connected';
        youtubeStatus.className = 'youtube-status disconnected';
        publishForm.classList.add('hidden');
      }
      return;
    } catch {
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 800));
      else {
        youtubeStatus.textContent = 'Could not reach server (refresh in a moment)';
        youtubeStatus.className = 'youtube-status disconnected';
      }
    }
  }
}

async function openYoutubeAuth() {
  try {
    const res = await fetch('/api/youtube/auth-url');
    const data = await res.json();
    if (data.url) window.open(data.url, '_blank', 'width=500,height=600');
    else showMessage(data.error || 'No auth URL', 'error');
  } catch (e) {
    showMessage('Failed to get auth URL', 'error');
  }
}

async function publishToYouTube() {
  if (!currentVideoBlob) {
    showMessage('Generate a video first.', 'error');
    return;
  }
  btnPublish.dataset.label = 'Publish to YouTube';
  setLoading(btnPublish, true);
  hideMessage();
  const form = new FormData();
  form.append('video', currentVideoBlob, 'video.webm');
  form.append('title', ytTitle.value.trim() || 'Generated Video');
  form.append('description', ytDesc.value.trim() || '');
  form.append('privacy', ytPrivacy.value);

  try {
    const res = await fetch('/api/youtube/upload', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.details || 'Upload failed');
    showMessage(`Published! ${data.url ? `Video: ${data.url}` : ''}`, 'success');
    if (data.url) window.open(data.url, '_blank');
  } catch (e) {
    showMessage(e.message || 'Upload failed', 'error');
  } finally {
    setLoading(btnPublish, false);
  }
}

btnVideo.addEventListener('click', generateVideo);
btnConnectYt.addEventListener('click', openYoutubeAuth);
btnPublish.addEventListener('click', publishToYouTube);

checkYoutubeStatus();

const params = new URLSearchParams(location.search);
if (params.get('youtube') === 'connected') {
  showMessage('YouTube connected. You can publish your video.', 'success');
  history.replaceState({}, '', location.pathname);
  checkYoutubeStatus();
}
if (params.get('youtube') === 'error') {
  showMessage('YouTube connection failed. Try again.', 'error');
  history.replaceState({}, '', location.pathname);
}
