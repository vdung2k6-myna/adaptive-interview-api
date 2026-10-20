FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# piper-tts is GPL-3.0-or-later and is deliberately absent from
# requirements.txt. Installing it here makes this image the one place the
# tier's GPL dependency lives; keep it a separate image from the others.
RUN pip install --no-cache-dir piper-tts

COPY main.py .

ENV HOST=0.0.0.0 \
    PORT=8083 \
    PIPER_MODELS_DIR=/voices

EXPOSE 8083

CMD ["python", "main.py"]
