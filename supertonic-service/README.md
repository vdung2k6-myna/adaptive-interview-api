# Supertonic TTS Service

A thin FastAPI wrapper around the open-source Supertonic 3 TTS model (via PyPI `supertonic`).

Endpoints:
  POST /v1/audio/speech    - Synthesize text to WAV audio
  GET  /health             - Health check

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Pre-download model weights
python -c "from supertonic import TTS; _ = TTS()"

# Start the service
python main.py
```

## Docker

```bash
# Build and run directly
docker build -t supertonic-tts-service:latest .
docker run -p 8084:8084 supertonic-tts-service:latest
```

## Environment

| Variable | Default      | Description |
|----------|--------------|-----------|
| PORT       | 8084         | HTTP port |
| HOST       | 127.0.0.1    | HTTP host |

## Note

The `supertonic` PyPI package downloads model weights from HuggingFace on first use.
The Dockerfile pre-downloads them during build so the container starts faster.
