FROM python:3.11-slim

# ffmpeg for video thumbnails, libpq for psycopg2
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libpq5 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p instance uploads tmp_uploads

ENV PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000

# Use 2 workers x 4 threads (gthread — never gevent, per project rules)
CMD gunicorn -w 2 -k gthread --threads 4 -b 0.0.0.0:${PORT:-8000} \
    --timeout 300 --keep-alive 65 app:app
