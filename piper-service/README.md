# Piper TTS Service

FastAPI wrapper for [Piper](https://github.com/rhasspy/piper) neural text-to-speech.

## Setup

### 1. Install dependencies

```bash
cd piper-service
pip install -r requirements.txt
```

**Note:** `piper-tts` phonemizes through `espeak-ng`, but you do **not** install
`espeak-ng` separately. The `piper-tts` wheel ships the engine's data inside the
package — `piper/espeak-ng-data/` (125 language dictionaries) plus a compiled
`piper/espeakbridge.pyd` — and initializes it from that directory. That bundling
is the point of the `piper1-gpl` fork, and it is also why that data is GPL-3.0:
see the licensing warning below.

Installing a system `espeak-ng` is harmless but unnecessary. If phonemization
fails, check that the installed `piper` package actually contains
`espeak-ng-data/` rather than reaching for a PATH entry.

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

> ⚠️ **Voice model licensing:** Piper voice models have independent licenses.
> `vais1000` (CC-BY-4.0) permits commercial use, but CC-BY is **not**
> unrestricted: it requires attribution to the licensor. Note also that a
> model card's dataset license describes the training data, not the trained
> weights. Users are responsible for complying with the license terms of each
> model they use. See the root [`NOTICE`](../NOTICE) file for details.

> ⚠️ **`piper-tts` is GPL-3.0-or-later.** It is a required runtime import but
> is deliberately absent from `requirements.txt`, so a fresh
> `pip install -r requirements.txt` produces a service that starts with zero
> voices. Install it yourself (`pip install piper-tts`). Because that package
> is a GPL fork carrying GPL-3.0 `espeak-ng` data, a distributed artifact
> combining it with this service is a GPL-3.0-or-later combined work — this
> service's own source remains MIT, but the artifact as a whole does not.
> See the root [`NOTICE`](../NOTICE) for the alternatives.

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
ship any particular model. Users are responsible for obtaining models
legally and complying with their license terms — including whether their use
case, commercial or not, is permitted.

Two things are easy to get wrong here:

1. **A model card's license is the dataset's license.** `MODEL_CARD` files in
   the upstream voice repository describe the corpus a voice was trained on.
   That is not by itself a grant covering the trained weights.
2. **Attribution-required is not unrestricted.** CC-BY-4.0 permits commercial
   use but obliges you to attribute the licensor.

This service also depends on the GPL-3.0-or-later `piper-tts` package, which
affects redistribution of the combined artifact. See the root
[`NOTICE`](../NOTICE) file for the full picture.

## License

The wrapper source in this directory is MIT, like the rest of the repository
(see the root [`LICENSE`](../LICENSE)).

**Scope carve-out.** This directory is excluded from any claim that the
repository as a whole is MIT-licensed. It cannot be used without
`piper-tts`, which is GPL-3.0-or-later, so a *deployed or distributed* Piper
stack is a GPL-3.0-or-later combined work. Treat the MIT grant here as
covering this source file set only, and treat anything built from it as GPL.

If that is not acceptable for your distribution, the alternative is to
replace `piper-tts` with a Piper implementation under a permissive license;
that is a code change, not a documentation one, and has not been made.
