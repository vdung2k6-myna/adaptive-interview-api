FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# The model cache and the voice style files both live under this directory.
# Mount a persistent host path at /cache so a replaced container does not
# re-download the weights or lose installed voices.
ENV HOST=0.0.0.0 \
    PORT=8084 \
    SUPERTONIC_CACHE_DIR=/cache

EXPOSE 8084

CMD ["python", "main.py"]
