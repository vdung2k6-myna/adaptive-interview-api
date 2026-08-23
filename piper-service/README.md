# Piper TTS Service

FastAPI wrapper for [Piper](https://github.com/rhasspy/piper) neural text-to-speech.

## Setup

### 1. Install dependencies

```bash
cd piper-service
pip install -r requirements.txt
```

**Note:** `piper-tts` requires `espeak-ng` for phonemization.

- **Windows:** Download from [espeak-ng releases](https://github.com/espeak-ng/espeak-ng/releases) and add to PATH.
- **Linux:** `sudo apt-get install espeak-ng`
- **macOS:** `brew install espeak`

### 2. Place your models

The service **auto-discovers** models from `./pipervoices` in the project root. You can also set `PIPER_MODELS_DIR` explicitly:

```bash
# Windows (PowerShell)
$env:PIPER_MODELS_DIR = "C:\\pipervoices"

# Linux/macOS
export PIPER_MODELS_DIR="/path/to/pipervoices"
```

Expected structure:

```
pipervoices/
└── vais1000/
    └── medium/
        ├── vi_VN-vais1000-medium.onnx
        └── vi_VN-vais1000-medium.onnx.json
```

> ⚠️ **Voice model licensing:** Piper voice models have independent
> licenses. `vais1000` (CC-BY-4.0) is a safe choice for unrestricted use.
> Users are responsible for complying with the license terms of each
> model they use. See the root `NOTICE` file for details.

### 3. Run

```bash
python main.py
# or
uvicorn main:app --host 127.0.0.1 --port 8083
```

## API

### POST /v1/audio/speech

Synthesize text to speech.

**Request:**
```json
{
  "text": "Xin chào, đây là bài kiểm tra giọng nói.",
  "voice": "vi_VN-vais1000-medium",
  "speaker_id": null
}
```

**Response:** `audio/wav` — WAV file bytes.

**Voice IDs** are derived from `.onnx` filenames:
- `vi_VN-vais1000-medium`

### GET /health

```json
{
  "status": "ok",
  "voices_loaded": 1,
  "voices": ["vi_VN-vais1000-medium"],
  "default_voice": "vi_VN-vais1000-medium"
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PIPER_MODELS_DIR` | *auto-discovered* | Directory to scan for `.onnx` models. Falls back to `./pipervoices` (project root), then common system paths. |
| `PORT` | `8083` | HTTP port |
| `HOST` | `127.0.0.1` | HTTP host |

## Voice Model Licensing

Each Piper voice model has its own license. The repository does **not**
ship or endorse any particular model. Users are responsible for obtaining
models legally and complying with their license terms.

See the root `NOTICE` file for details.
