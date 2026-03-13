# VidGenerator — Prompt → Meme Script → Video → YouTube

Nhập prompt, AI (Gemini) tạo **title + script meme**, app chọn **GIF/video meme** làm background, render video (GIF + chữ), sau đó bạn **duyệt (Approve)** và **đăng lên YouTube** bằng một nút.

## Cần có

1. **Gemini API key** – [Tạo tại Google AI Studio](https://aistudio.google.com/apikey) (free tier).  
2. **YouTube OAuth** – Dự án Google Cloud, bật YouTube Data API v3 và tạo OAuth 2.0 Client (xem bên dưới).

## Chạy nhanh

```bash
npm install
cp .env.example .env
# Sửa .env: thêm GEMINI_API_KEY và (tuỳ chọn) YouTube credentials
npm run dev
```

- **App:** http://localhost:5173  
- **API:** http://localhost:3001  

Nếu lần đầu bị lỗi kết nối, đợi vài giây cho server chạy rồi refresh trang.

## Cấu hình

### 1. Gemini (tạo title + script)

- Vào [Google AI Studio](https://aistudio.google.com/apikey) tạo API key.  
- Ghi vào `.env`: `GEMINI_API_KEY=...`

App dùng model `gemini-1.5-flash` để sinh:
- `title`: tiêu đề ngắn cho video,
- `lines`: danh sách câu sub ngắn để hiển thị lần lượt.

### 2. YouTube (đăng video)

1. Mở [Google Cloud Console](https://console.cloud.google.com/).
2. Tạo/chọn project, bật [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
3. Vào **APIs & Services → Credentials** → tạo **OAuth 2.0 Client ID** (Web application).
4. Thêm **Authorized redirect URI**: `http://localhost:3001/api/youtube/oauth2callback`
5. Điền **Client ID** và **Client secret** vào `.env`:
   - `YOUTUBE_CLIENT_ID=...`
   - `YOUTUBE_CLIENT_SECRET=...`

Trong app: bấm **Connect YouTube account** → đăng nhập → sau đó dùng **Publish to YouTube** để đăng video.

## Luồng sử dụng

1. **Prompt** – Gõ mô tả (vd: "meme chó buồn về thất tình, tone hài bựa").  
2. **Generate video** – Backend gọi Gemini sinh `title + lines`. Frontend:
   - Random chọn GIF/video meme làm background,
   - Render video: nền GIF + title ở giữa + từng dòng subtitle chạy dưới,
   - Ghi lại bằng MediaRecorder thành file video.
3. **Approve video** – Bạn xem trước, nếu ok bấm **Approve video**.  
4. **Publish to YouTube** – Nhập title/description, chọn privacy, bấm **Publish to YouTube**.

## Production

```bash
npm run build
PORT=3001 node server/index.js
```

Serve app cùng origin với API (vd reverse proxy). Trong `.env` đặt `YOUTUBE_REDIRECT_URI` đúng URL callback production.
