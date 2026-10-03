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
  "voice": "diem_trinh"
}
```

`voice` is **required** by the request schema. An empty string is accepted and
falls back to this service's default voice — `DEFAULT_VOICE` when that names an
available voice, otherwise the first one `list_voices()` returns. Any other
value must match an available voice exactly or the request is refused with
`400` naming the voices that exist. There is no `"default"` voice: it is not a
name in the voice list, so sending it is a 400. Read the real names from
`GET /health`.

**Response:** `audio/wav` binary

**cURL example:**
```bash
curl -X POST http://localhost:8081/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"tts","input":"Hello world","voice":"diem_trinh"}' \
  --output output.wav
```

### GET /health

Health check. It loads the model if it has not been loaded yet, so a healthy
answer means the model really is loadable.

**Response:**
```json
{
  "status": "ok",
  "voices": ["diem_trinh", "..."],
  "default_voice": "diem_trinh"
}
```

When the model files are missing it returns `{"status": "error", "message": "..."}` with HTTP `200` — check the `status` field, not the status code.

## Licensing

The service code in this directory is MIT, like the rest of the repository
(see the root [`LICENSE`](../LICENSE)).

The Vietnamese model is a separate matter:

- **Model files** (`kokoro_vi.onnx`, `kokoro_vi.pth`, `kokoro_vi_voicepack.pt`,
  `config.json`) come from
  [contextboxai/Kokoro-Vietnamese](https://huggingface.co/contextboxai/Kokoro-Vietnamese)
  and are **Apache-2.0**. `download_models.py` fetches them at install time and
  `kokoro-service/models/` is gitignored, so this repository does not
  redistribute them. If you redistribute them yourself, carry the Apache-2.0
  notice.
- **A transitive dependency has no license.** `kokoro-vietnamese` declares
  `vig2p>=0.1.0`, whose distribution metadata carries no license, no license
  file, and no author or project URL. Absent an explicit grant, no
  redistribution right is granted. Worth resolving upstream before shipping a
  Kokoro-based distribution.

See the root [`NOTICE`](../NOTICE) for the rest of the audio stack.
