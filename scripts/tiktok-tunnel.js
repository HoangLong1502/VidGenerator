#!/usr/bin/env node
/**
 * Chạy tunnel ngrok tới port 3001 để TikTok Login Kit (HTTPS redirect) hoạt động.
 * Cách dùng:
 *   1. Terminal 1: npm run dev
 *   2. Terminal 2: npm run tiktok:tunnel
 *   3. Copy URL https://... từ ngrok, thêm vào TikTok Portal và .env (xem in ra bên dưới).
 */

import { spawn } from 'child_process';

const PORT = process.env.PORT || 3001;

console.log(`
  TikTok Login Kit cần Redirect URI dạng https://...
  Ngrok sẽ tạo tunnel: https://xxx.ngrok-free.app -> http://localhost:${PORT}

  Sau khi ngrok chạy:
  1. Copy dòng "Forwarding  https://xxxx  -> ..." (URL https://...)
  2. TikTok Portal > Login Kit > Web > Redirect URI: thêm
        https://XXXX/api/tiktok/oauth2callback
  3. Trong .env thêm hoặc sửa:
        TIKTOK_REDIRECT_URI=https://XXXX/api/tiktok/oauth2callback
  4. Restart server (Ctrl+C rồi npm run dev lại).
  5. Giữ terminal này mở khi test Connect TikTok.

  Đang chạy ngrok...
`);

// Dùng chuỗi đầy đủ để Windows shell truyền đúng: ngrok http 3001
const child = spawn(`ngrok http ${PORT}`, {
  stdio: 'inherit',
  shell: true,
});

child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(`
  Chưa cài ngrok. Làm một trong hai:
  - Tải: https://ngrok.com/download
  - Hoặc: winget install ngrok
  Sau đó chạy lại: npm run tiktok:tunnel
`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
