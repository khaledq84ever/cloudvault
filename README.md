# CloudVault ☁️

Personal cloud file storage — like Dropbox/Google Drive. Built with Flask + SQLite.

## Run locally
```bash
pip install -r requirements.txt
python3 app.py
# open http://localhost:5000
```

## Features
- 🔐 Email/password auth (Flask-Login, bcrypt hashes)
- 📤 Upload files with drag-and-drop + progress bar
- 📁 Folders, breadcrumbs, nested navigation
- ⭐ Star, ✏ rename, 🗑 trash (soft delete), restore
- 🔗 Public share links with optional expiry
- 👁 Inline preview for images, video, audio, PDF, text
- 🔍 Search by filename
- 💾 15 GB free quota per user (configurable)
- 📱 Mobile-first responsive UI with bottom nav

## Deploy to Railway
1. `git init && git add . && git commit -m "init"`
2. Push to GitHub
3. Railway → New Project → Deploy from repo
4. Add a Volume mounted to `/app/uploads` and `/app/instance` for persistence
5. Set `SECRET_KEY` env var

## Switching storage to S3/R2 (production)
Replace `user_dir()` / `send_file()` calls in `app.py` with `boto3` `put_object` / signed URLs.
Storage keys are already UUIDs — just point them at your bucket.

## Tech stack
- Backend: Flask 3, SQLAlchemy, Flask-Login
- Frontend: vanilla JS + CSS (no framework)
- Storage: local FS (swap to S3/R2 for prod)
- DB: SQLite (swap to Postgres for prod)
