# CloudVault — next-session upgrade prompt

> Paste the block below into a fresh Claude Code session to continue
> upgrading CloudVault. Everything between the `===` markers is
> self-contained and assumes no prior context.

```
==========================================================
You are continuing work on CloudVault — a free-tier personal cloud
drive at https://cloudvault-production-9ea1.up.railway.app/drive.
The repo lives at /home/khaled/cloudvault/ and auto-deploys to
Railway on every push to main.

CURRENT STATE (as of 2026-05-23, do NOT redo any of this):
- Stack: Flask 3 + SQLAlchemy + Postgres (Railway plugin) + Flask-Login
  + gunicorn gthread. Files persist on a Railway volume mounted at
  /app/data. NEVER use gevent worker (it hangs ffmpeg).
- One plan only: free, 500 MB quota per account, 100 MB max single
  file. No Stripe, no Pro, no Business — those have been removed.
  PLANS = {"free": {...500 MB...}} in app.py.
- Pricing/billing routes redirect to /drive. /api/plan/upgrade returns
  410 Gone. Don't reintroduce paid plans.
- Share links are PERMANENT (expires_at = NULL) and auto-created on
  every upload. /s/<token> shows preview, /s/<token>/download streams
  the file directly with no login required.
- Password reset works at /forgot. Uses Resend if RESEND_API_KEY is
  set, otherwise shows the link on the success page.
- Free VPS shell at /vps — per-user bubblewrap sandbox, --unshare-net,
  500 MB disk quota. Don't break it.
- Storage bug fixed: storage.py _path() creates parent dirs so the
  _thumb/ subdir auto-materializes. Image uploads work.
- Default file sort is date desc; after every upload the UI forces
  date desc and scrolls to top so new files are unmissable.
- Service worker is at v2 — bump VERSION in static/sw.js if you ship
  client-side fixes that need to bust cached PWA assets.
- Test account: khaled@cv.com / secret123 (id=1, on free plan, has
  ~8 files including a test.png with a working thumbnail).

CONSTRAINTS (non-negotiable):
- Keep the app 100% free for users. No payment UI, no Stripe code,
  no "Upgrade" buttons, no plan tiers. If you find any leftover
  pricing references in templates, delete them.
- All users on free 500 MB tier with 100 MB max file size.
- Mobile-first: every change must work on phones in both portrait
  and landscape, including the installed PWA.
- Don't bundle unrelated work in one commit — stage by name.

WHAT TO UPGRADE NEXT:

1. UPLOAD RELIABILITY
   - Resumable progress that survives a tab refresh (persist
     upload_id + offset in localStorage; resume any in-flight uploads
     on page load).
   - Surface server-side errors clearly: quota exceeded, file too
     large, unsupported mime — today they all read "Upload failed".
   - Mobile: add a separate "Camera" button using
     capture="environment" for direct photo capture, plus accept="*/*"
     on the main file input.
   - Background-sync upload queue when offline (IDB + service worker).

2. STORAGE LAYER
   - Add Cloudflare R2 toggle — storage.py already has R2Storage;
     setting R2_ENDPOINT/BUCKET/KEY/SECRET env vars flips the factory.
     Verify range requests (video scrubbing) still work via presigned
     URLs.
   - SHA-256 dedup: blob stored once, reference-counted across users.
   - "Purge orphans" CLI command: scan /app/data/uploads/* and delete
     blobs whose storage_key isn't in any File row.

3. SHARE LINKS
   - Custom alias: /s/my-vacation-photo instead of /s/<22-char-token>.
     Add Share.alias unique column; resolve alias first, fall back to
     token.
   - QR code in the share modal (qrcode[pil], data-URL).
   - Click analytics: bump Share.downloads + Share.views; surface
     them in the share modal and /shared list.
   - Folder shares: Share.folder_id column, /sf/<token> route lists
     files + download-all-as-zip button.

4. POLISH
   - Make the empty state ("Nothing here yet") clickable — tap opens
     the file picker directly.
   - Mobile bottom-nav "+" opens an action sheet (Upload, New folder,
     Take photo, Paste link) instead of a plain file picker.
   - "Recently deleted" badge on Trash nav item with pending-purge
     count.

WORKFLOW:
- One feature per commit. Small frequent deploys.
- After every push: poll `railway status` until "Online" without
  Initializing/Deploying/Building, then smoke-test with curl AND
  grep `railway logs --deployment` for new exceptions.
- Test account khaled@cv.com / secret123 is the canonical target.

START BY: ask the user which area to tackle first, OR propose a
30-minute next step and wait for confirmation before touching code.
==========================================================
```
