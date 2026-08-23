# Kokoro TTS FastAPI Service

Fast, lightweight TTS using Kokoro ONNX for the Adaptive Interview Engine.

## Quick Start

```bash
# 1. Create virtual environment
python -m venv .venv

# 2. Activate (Windows PowerShell)
.venv\Scripts\Activate.ps1
#    Activate (Linux/macOS)
source .venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Download models (one-time)
python download_models.py

# 5. Start server
python main.py
```

Server will be available at `http://localhost:8081`.

## API Endpoints

### POST /v1/audio/speech

Synthesize text to speech.

**Request:**
```json
{
  "model": "tts",
  "input": "Xin chào, bạn khỏe không?",
  "voice": "default"
}
```

**Response:** `audio/wav` binary

**cURL example:**
```bash
curl -X POST http://localhost:8081/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"tts","input":"Hello world","voice":"default"}' \
  --output output.wav
```

### GET /health

Health check.

**Response:**
```json
{"status": "ok"}
```
