# CloudVault — pro prompts for next sessions

> Each block below is a self-contained prompt you can paste verbatim into a fresh Claude Code session and it will know exactly what to do.

**Always-true context to keep in mind (you don't need to repaste this — it's in CLAUDE.md and memory):**
- Local dir: `/home/khaled/cloudvault/`
- Live URL: https://cloudvault-production-9ea1.up.railway.app
- GitHub: `khaledq84ever/cloudvault` (push to `main` → Railway auto-deploys)
- Test account: `khaled@cv.com` / `secret123` (Pro plan, persisted via volume)
- Stack: Flask 3 + SQLAlchemy + Flask-Login + Pillow + ffmpeg (gthread workers, never gevent)

---

## 1. Real Stripe payment (replace mock checkout)

Replace the mock `/api/plan/upgrade` checkout on `/pricing` with real Stripe Checkout Sessions. Implementation contract:

- Add `stripe` to `requirements.txt`. Read `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` from env. If `STRIPE_SECRET_KEY` is missing, keep the existing mock flow as a graceful fallback.
- New route `POST /api/stripe/checkout` — body `{ "plan": "pro" | "business" }` — creates a Stripe Checkout Session in `subscription` mode with `customer_email = current_user.email`, `client_reference_id = current_user.id`, `success_url = /billing?success=1`, `cancel_url = /pricing?cancelled=1`. Return `{ "url": session.url }`. Frontend on `/pricing` redirects to it.
- New route `POST /api/stripe/webhook` — verify signature with `stripe.Webhook.construct_event`. Handle `checkout.session.completed` (set `user.plan`, `user.plan_expires_at = now + 31 days`, `user.stripe_customer_id`, `user.stripe_subscription_id`), `customer.subscription.updated` (sync plan), `customer.subscription.deleted` (revert to free).
- Add `stripe_customer_id` and `stripe_subscription_id` columns to `User` model + migrate on boot like the existing pattern.
- Add a "Manage subscription" button to `/billing` that hits `POST /api/stripe/portal` → creates a Stripe Customer Portal session and redirects.

Acceptance: end-to-end test on live with Stripe test mode card `4242 4242 4242 4242`. Verify the webhook updates the user's plan (check via `/api/me`) and the Manage button opens the real portal. Keep the mock path working for sessions where the env vars aren't set so local dev still functions.

---

## 2. Admin dashboard

Build a real admin dashboard at `/admin`, gated by an `ADMIN_EMAILS` env var (comma-separated). Anyone not in that list gets 404 (not 403 — don't reveal it exists).

Page shows, in a single dense grid:
- **KPIs**: total users, total bytes stored, total shares, count of users on each plan, total monthly revenue (sum `plan price × active subscribers`).
- **Top 10 biggest accounts**: name, email, plan, GB used, signup date, last activity. Click row → expand to show their files (read-only).
- **Recent signups**: last 20, with "suspend" button (sets `user.suspended_at`, login fails when set, sign-in returns "Account suspended").
- **Recent shares**: last 50 share links with file name, owner, click count, expiry.
- **Storage chart**: bar chart of storage growth by day for last 30 days. Pure SVG, no external lib.

Implementation:
- Decorator `@admin_required` next to `@login_required`.
- New template `templates/admin.html` extending the appnav.
- New routes: `/admin`, `POST /api/admin/suspend/<user_id>`, `POST /api/admin/unsuspend/<user_id>`.
- All admin actions must `app.logger.info(...)` for audit trail.

Acceptance: only `kkkk3031@gmail.com` (and anything else set in ADMIN_EMAILS) can see the page. Suspending a user logs them out and blocks login. The chart actually renders 30 bars with real data.

---

## 3. Version history for files

When a user uploads a file with the same name into the same folder, keep the previous version instead of overwriting silently.

Implementation:
- New model `FileVersion(id, file_id, storage_key, size, mime, created_at)`.
- In `/api/upload` and `/api/upload/<id>/complete`, before replacing `File.storage_key`, copy the old metadata into a new `FileVersion` row. Keep up to 10 versions per file (delete oldest beyond that, and delete the underlying storage object).
- New routes:
  - `GET /api/files/<id>/versions` → list of versions, newest first
  - `POST /api/files/<id>/versions/<version_id>/restore` → swap current and the chosen version
  - `GET /api/files/<id>/versions/<version_id>/download` → download a specific version

UI: in the details panel (right sidebar) add a "Versions" collapsible section. Shows version count, click expands to list with date + size + "Restore" + "Download" per row. The current version is labeled "Current" and not restorable.

Acceptance: upload `foo.txt` (v1), upload `foo.txt` again with different content (v2), confirm details panel shows 2 versions, restoring v1 swaps them, downloading v1 returns the original bytes.

---

## 4. Public folder sharing

Today you can share individual files via `/s/<token>`. Extend the same primitive to whole folders.

Implementation:
- New column on `Share`: `folder_id` (nullable, mutually exclusive with `file_id`).
- Existing share modal in `drive.html`: when right-clicking a folder, open the same modal but pass `kind=folder`.
- New route `/sf/<token>` renders `templates/share_folder.html`. Shows folder name, breadcrumb, list of items (files + subfolders), "Download all as zip" button, per-file download.
- Password/expiry/view-only/download-count logic — reuse exactly what `/s/<token>` does. Subfolder browsing stays inside the shared root (block traversal).
- Recursive zip uses existing `_stream_zip_folder` helper.

Acceptance: share a folder with 3 files and 1 subfolder, open `/sf/<token>` in an incognito window, browse the subfolder, download a single file, download the whole tree as zip. Then revoke the share and confirm the URL returns 410.

---

## 5. Two-factor auth (TOTP)

Add optional 2FA to user accounts.

Implementation:
- Add `pyotp` and `qrcode[pil]` to `requirements.txt`.
- New columns on `User`: `totp_secret` (string, nullable), `totp_enabled_at` (datetime, nullable).
- New `/settings/2fa` page (linked from the existing Settings page):
  - If disabled: "Enable 2FA" button → generates a secret, shows QR code (data URL, no external request), input box for the user to enter a 6-digit code from their authenticator. Only on a successful code does the system flip `totp_enabled_at` and save the secret.
  - If enabled: show "2FA is on", date enabled, and a "Disable" button (requires password + valid current code).
- Login flow: after password check, if `totp_enabled_at` is set, redirect to `/2fa-verify` (don't grant the session yet — store a short-lived signed token in the cookie). Wrong codes are rate-limited (5/min via flask-limiter).
- Recovery codes: on enable, also show 8 one-time recovery codes the user can save (store as hashes). Used codes are invalidated.

Acceptance: enable 2FA on the test account, log out, log back in — should be prompted for the code, wrong codes get rejected, right code logs in. Recovery code works exactly once.

---

## 6. Email notifications via Resend

Wire up real transactional emails using Resend.

Implementation:
- Add `resend` to `requirements.txt`. Read `RESEND_API_KEY` and `RESEND_FROM` env vars. If absent, the email layer becomes a no-op that logs and returns.
- New module `mail.py` with templated helpers:
  - `send_welcome(user)` — on register
  - `send_share_viewed(share, viewer_ip)` — fires on the FIRST view of a share link (debounce per session via cache)
  - `send_share_downloaded(share)` — fires on download
  - `send_quota_warning(user, pct)` — fires when usage crosses 90% (check on every upload completion)
  - `send_plan_renewal(user, plan)` — fires on Stripe `customer.subscription.updated`
- Templates as inline HTML in `mail.py` (no external file). Brand: gradient header, plain text body, footer "Sent by CloudVault — manage your notifications in Settings".
- New `/settings/notifications` page with checkboxes for each category, stored as JSON in a new `User.notification_prefs` column.

Acceptance: enable Resend in env, register a new test account, confirm welcome email arrives. Share a file, open the link in incognito, confirm the share-viewed email arrives. Upload until quota >90%, confirm the warning email arrives.

---

## 7. AI: semantic search + auto-tag + summarize + NL commands

The full AI pass we deferred. Locked in: **sqlite-vec** for vector storage. Provider needs to be chosen at session start (Anthropic+Voyage, OpenAI, or local sentence-transformers).

Implementation, in this order:

1. **Embeddings infra**:
   - Add `sqlite-vec` to `requirements.txt` and load the extension on boot. Create a virtual table `file_vectors USING vec0(file_id INTEGER PRIMARY KEY, embedding float[1024])` (size depends on provider — Voyage = 1024, OpenAI text-embedding-3-small = 1536).
   - New worker that on upload completion (a) extracts text (pdfplumber for PDF, python-docx for docx, plain read for text/code), (b) embeds the first 8KB of text + the filename, (c) inserts into `file_vectors`. Runs in a background thread, doesn't block upload completion.
   - Re-index button in `/settings` for backfilling existing files.

2. **Semantic search**:
   - Replace the `q=` filter in `/api/files` with a hybrid: if `?q=` is set and is >2 chars, run BOTH a SQL LIKE on filename AND a vector similarity search, then merge by deduplicated file_id, ranked by best score across both.
   - UI: search results show a small "Why this match" tooltip with the matched text snippet for vector hits.

3. **Auto-tagging**:
   - On upload completion, send the filename + first 500 chars of extracted text to the LLM with the prompt: "Return a JSON array of 1-3 short tags (lowercase, single word each) that categorize this file. Choose from existing tags first if any apply. Existing tags: [...]". Cache the tag list per-user and refresh on tag CRUD.
   - Auto-attach the returned tags to the `File.tags` relationship. Don't ask user — just do it silently. They can remove if wrong.

4. **Content summarization**:
   - New `File.ai_summary` column. Same upload-time worker generates a 1-line summary (max 140 chars). Shown in the details panel and used as the second line in list view.

5. **Natural-language commands**:
   - New chat bubble in the bottom-right corner of `/drive` (collapsed by default). Click to expand.
   - On submit, send the message to the LLM with a tools array: `list_files`, `move_file`, `trash_file`, `share_file`, `tag_file`, `rename_file` — each one is a real `/api/...` call.
   - LLM streams its reasoning + tool calls; the UI shows a thinking indicator and a confirmation step for any destructive action ("Move 12 files to /Archive — confirm?").
   - Keep a server-side audit log of every NL command + tool call + outcome.

Acceptance: index all existing files (12+), search "tax document" and find `2025-W2.pdf` even though the query doesn't match the filename. Upload a new PDF and watch it get auto-tagged within a few seconds. Open the NL chat and say "move all my PDFs into a Documents folder" — verify it asks for confirmation, then actually does it.

---

## 8. Mobile-native app via Capacitor

Wrap the existing CloudVault web app as a real iOS + Android app using Capacitor (no rewrite of the web code).

Implementation:
- New top-level dir `mobile/` with a Capacitor project pointing `server.url` at the live Railway URL (for dev) and at the local web build (for prod).
- Configure: app id `com.cloudvault.app`, name "CloudVault", splash + icon from `static/icons/` (192/512 sources).
- Add native plugins: `@capacitor/camera`, `@capacitor/share`, `@capacitor/filesystem`, `@capacitor/push-notifications`.
- Add a JS bridge in `static/js/native.js` that detects `Capacitor.isNativePlatform()` and swaps the web file-picker for the native camera/document picker when available.
- Register a share extension on iOS / share intent on Android so other apps can "Send to CloudVault" — payload hits a new `/api/upload/from-share` endpoint with a one-time token.
- Build instructions in `mobile/README.md` for both platforms.

Acceptance: `npx cap run android` opens the app on a connected device, loads the live site, login works, taking a photo from inside the app uploads it to your drive. Same on iOS via Xcode.

---

## 9. Real-time collaboration on shared folders

Today shares are read-only public links. Add real multi-user collaboration on folders.

Implementation:
- New table `FolderMember(id, folder_id, user_id, role: 'viewer'|'editor', invited_by, invited_at, accepted_at)`.
- New route `POST /api/folders/<id>/invite` with body `{ email, role }`. Sends an email via the Resend layer (#6) with a magic link `/invite/<token>`. If the email isn't a user yet, create a placeholder account and let them claim it via password setup at the link.
- The `/api/files` query now also returns files from folders the user is a member of (with the right role gating writes).
- New view `/shared-with-me` (separate from existing `/shared` which is "shared BY me"). Shows folders shared with the current user.
- Existing SSE bus extends to all members of a shared folder — when one uploads, everyone gets the `file.added` event.
- Add a "presence" indicator: when 2+ users have the same folder open, show their avatars in the topbar.

Acceptance: create folder "Team", invite a second account, sign in as that account, see "Team" under Shared with me, upload a file from there — original account sees it appear in real time.

---

## 10. Push the PWA to its limit

Take the PWA you already shipped (manifest + service worker + install prompt) further.

Implementation:
- Service worker upgrades:
  - Pre-cache the full app shell (drive.html, all CSS/JS) on install for true offline drive view.
  - Background sync: queue uploads when offline via the SyncManager API. Retry on `online` event.
  - Periodic sync (where supported) for share-link click notifications.
- Push notifications:
  - Register VAPID keys (env vars `VAPID_PUBLIC`, `VAPID_PRIVATE`).
  - Subscription endpoint `POST /api/push/subscribe`, server stores subscription per user.
  - Send pushes for: share viewed, share downloaded, quota warning, collab activity.
- Custom install UX:
  - First-visit landing page banner "Install CloudVault — it's faster as an app", dismissable.
  - In-app install button that uses the saved `beforeinstallprompt` event.
  - iOS-specific instructions modal when `standalone` isn't true and userAgent looks like iOS (Add to Home Screen flow).
- App shortcuts (already in manifest) get tested in dev tools to ensure long-press on the home icon shows them.

Acceptance: install the PWA on a real Android phone, kill connectivity, open the app, see the drive view from cache. Upload a file while offline — it queues, reconnect, the upload completes. A second device with the same account installed gets a push notification when a share link is clicked.
