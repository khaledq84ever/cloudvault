FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libpq5 ca-certificates \
      bubblewrap bash coreutils python3 git curl vim-tiny nano less procps \
      iproute2 net-tools file tree htop ncdu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p instance uploads tmp_uploads

ENV PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000

CMD gunicorn -w 2 -k gthread --threads 4 -b 0.0.0.0:${PORT:-8000} \
    --timeout 300 --keep-alive 65 --access-logfile - --error-logfile - app:app
