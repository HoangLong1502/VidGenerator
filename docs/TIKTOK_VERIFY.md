# TikTok URL verification (GitHub Pages)

Sau khi bật GitHub Pages, TikTok sẽ yêu cầu verify từng URL. Làm lần lượt:

1. **Trong TikTok Developer Portal** → app VidGenerator → bấm nút **"URL properties"** (gần đầu trang app).
2. Chọn **Verify by URL prefix**. Với từng URL (Web URL, Terms, Privacy):
   - Nhập đúng URL (xem bên dưới).
   - Bấm **Verify** → TikTok cho tải file (tên dạng `tiktok_verify_xxxxx.html`).
   - Đặt file đó vào thư mục **`docs/`** của repo (cùng cấp với `index.html`).
   - Push lên GitHub. Đợi vài phút cho Pages cập nhật.
   - Bấm **Verify** lại trong TikTok.

**URL cần dùng (thay `hoanglong1502` bằng username GitHub của bạn nếu khác):**

- **Web/Desktop URL:** `https://hoanglong1502.github.io/VidGenerator/`
- **Terms of Service URL:** `https://hoanglong1502.github.io/VidGenerator/terms.html`
- **Privacy Policy URL:** `https://hoanglong1502.github.io/VidGenerator/privacy.html`

Sau khi verify xong cả 3, lỗi "This URL is not verified" sẽ hết.
