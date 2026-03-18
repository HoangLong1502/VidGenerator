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

### 3. TikTok (đăng video)

1. Tạo app tại [TikTok for Developers](https://developers.tiktok.com/) → **Manage apps** → lấy **Client Key** và **Client Secret**.
2. Trong app TikTok:
   - Thêm sản phẩm **Login Kit** (bắt buộc cho OAuth).
   - Thêm **Redirect URI** khớp **chính xác** với backend (xem bên dưới).
3. TikTok **chỉ chấp nhận Redirect URI bắt đầu bằng https://**. Dùng tunnel ngrok:
   - **Cài ngrok:** [Tải](https://ngrok.com/download) hoặc `winget install ngrok`.
   - **Đăng ký ngrok (miễn phí):** [Sign up](https://dashboard.ngrok.com/signup) → vào [Your authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) → chạy một lần: `ngrok config add-authtoken <token>` (hoặc thêm `NGROK_AUTHTOKEN=<token>` vào `.env`).
   - **Terminal 1:** `npm run dev` (chạy app như bình thường).
   - **Terminal 2:** `npm run tiktok:tunnel` hoặc `ngrok http 3001`.
   - Trong terminal ngrok sẽ hiện dòng dạng `Forwarding  https://abc123.ngrok-free.app -> http://localhost:3001`. Copy **https://abc123.ngrok-free.app**.
   - **TikTok Portal** > Login Kit > Web > Redirect URI: thêm `https://abc123.ngrok-free.app/api/tiktok/oauth2callback` (thay `abc123` bằng subdomain thật của bạn).
   - Trong **.env** thêm hoặc sửa: `TIKTOK_REDIRECT_URI=https://abc123.ngrok-free.app/api/tiktok/oauth2callback`.
   - **Restart server** (Ctrl+C rồi `npm run dev` lại). Giữ terminal ngrok mở khi test Connect TikTok.
4. Điền vào `.env`: `TIKTOK_CLIENT_KEY=...`, `TIKTOK_CLIENT_SECRET=...` (không thêm khoảng trắng thừa).

Kiểm tra cấu hình: mở `http://localhost:3001/api/tiktok/check-config` để xem `redirect_uri` đang dùng và so với TikTok Developer Portal.

5. **Verify 3 URL (Terms, Privacy, Web/Desktop):** TikTok bắt verify mọi URL. Cần dùng domain bạn sở hữu (vd GitHub Pages):
   - Bật **GitHub Pages** cho repo: Settings → Pages → Source: Deploy from branch → branch `main`, folder **`/docs`** → Save. Site sẽ ở `https://<username>.github.io/VidGenerator/`.
   - Trong TikTok App details, đổi 3 URL thành (thay `<username>` bằng GitHub username của bạn):
     - **Web/Desktop URL:** `https://<username>.github.io/VidGenerator/`
     - **Terms of Service URL:** `https://<username>.github.io/VidGenerator/terms.html`
     - **Privacy Policy URL:** `https://<username>.github.io/VidGenerator/privacy.html`
   - Trong TikTok, bấm **URL properties** (đầu trang app) → Verify by **URL prefix** → với từng URL: TikTok cho tải file `tiktok_verify_xxx.html` → đặt file vào thư mục **`docs/`** trong repo → push lên GitHub → bấm Verify lại. Chi tiết: xem `docs/TIKTOK_VERIFY.md`.

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
