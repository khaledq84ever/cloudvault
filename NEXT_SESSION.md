# CloudVault — copy-paste prompts for next session

Live: https://cloudvault-production-9ea1.up.railway.app
Repo: khaledq84ever/cloudvault (push to `main` → GitHub Actions auto-deploys)
Persistent test account: `khaled@cv.com` / `secret123` (Pro, 100 GB)

---

## 🔥 Resume this first (where we left off)

Continue the CloudVault cross-device optimization pass at /home/khaled/cloudvault.
Two open tasks were not finished:

1. PWA manifest + icons + service worker (installable on Android, Add to Home Screen on iOS)
2. Mobile + browser CSS hardening: iOS safe-area-inset, 16px-min input font-size to prevent zoom, 44x44 tap targets, -webkit- backdrop-filter fallbacks, breakpoints for phone/tablet/laptop/desktop, -webkit-tap-highlight-color: transparent

Live URL: https://cloudvault-production-9ea1.up.railway.app
GitHub: khaledq84ever/cloudvault (auto-deploys on push to main)
Account that persists: khaled@cv.com / secret123 (Pro plan, 100 GB)

After making changes, push to main and the GitHub Action auto-deploys.
Run the full auto-test (all public pages + auth pages + APIs) and report.

---

## 🎨 Backlog (fire one at a time)

### Real Stripe payment (replace mock checkout)
Replace the mock /pricing checkout with real Stripe Checkout. Use test keys via STRIPE_SECRET_KEY env var. On webhook success at /api/stripe/webhook, set user.plan and plan_expires_at. Keep mock as fallback when key missing.

### Admin dashboard
Add /admin restricted to a hardcoded ADMIN_EMAILS env var list. Show: total users, total storage used, top 10 biggest accounts, recent signups, total shares, revenue (sum of paid plans). Add ability to suspend a user.

### Public file browser for shared folders
Add ability to share whole folders publicly (not just files). New /sf/<token> route that lists folder contents with subfolders, breadcrumbs, individual file downloads, and a "Download all as zip" button.

### Two-factor auth
Add TOTP 2FA. Add /settings/2fa page with QR code (use pyotp + qrcode lib). Store user.totp_secret encrypted. On login, if 2FA enabled, redirect to /2fa-verify before granting session.

### Email notifications
Add email notifications for: share-link viewed, share-link downloaded, quota >90%, plan renewal. Use Resend.com API with RESEND_API_KEY env var. Template renderer in mail.py.

### Mobile app feel via PWA
Push the PWA further: add app-shell caching, offline page, background sync for uploads, push notifications via Web Push API + VAPID keys, "install app" prompt with custom UI.

### File search inside content
Index uploaded text/PDF/docx content. On upload, extract text (use pdfplumber for PDF, python-docx for docx) and store in a SQLite FTS5 table. Add full-text search to /api/files?q= so users can find files by content, not just filename.

### Real-time collaboration
Add multi-user shared folders. Folder.shared_with table, invite-by-email flow, permission levels (view / edit). Members see each other's uploads via existing SSE. Add a "Shared with me" view.

### Version history
On every overwrite of a file (same name in same folder), keep the old version as FileVersion(id, file_id, storage_key, size, created_at). Add /api/files/<id>/versions endpoint. UI: dropdown in details panel showing all versions with restore + download per version.

### Mobile-native app via Capacitor
Wrap CloudVault in Capacitor to ship as a real Android APK and iOS app. Configure capacitor.config.ts pointing to the live URL, add splash screen, app icon, native share intent for "Send to CloudVault" from other apps.
