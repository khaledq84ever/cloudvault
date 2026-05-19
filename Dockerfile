FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p instance uploads
ENV PORT=8000
EXPOSE 8000
CMD gunicorn -w 2 -k gthread --threads 4 -b 0.0.0.0:${PORT:-8000} --timeout 120 app:app
