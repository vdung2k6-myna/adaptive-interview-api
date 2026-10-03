# Supertonic TTS Service

A thin FastAPI wrapper around the Supertonic 3 TTS model (via the PyPI
`supertonic` package). The wrapper is MIT; the model weights are not — see
[Licensing](#licensing).

Endpoints:
  POST /v1/audio/speech    - Synthesize text to WAV audio
  GET  /health             - Health check, including the voices this service holds

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Pre-download model weights
python -c "from supertonic import TTS; _ = TTS()"

# Start the service
python main.py
```

## Voices

The set of voices this service can speak in is the set of style files in its
style directory — Supertonic 3's ten built-ins (F1–F5, M1–M5) plus anything
installed alongside them. There is no code change and no registry to update: a
style file is the voice.

```bash
# What is loaded right now
curl localhost:8084/health
```

```json
{
  "status": "ok",
  "default_voice": "F1",
  "sample_rate": 44100,
  "voices": ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"],
  "unreadable_voices": []
}
```

### Installing a voice

Drop the style JSON into the style directory, which is
`$SUPERTONIC_CACHE_DIR/voice_styles/` when that variable is set, and
`~/.cache/supertonic3/voice_styles/` otherwise. The file's name is the voice
name — `me.json` is the voice `me`. Restart the service to pick it up.

A style file is only read once at startup; a file added afterwards is not
picked up until the service restarts.

Install a voice into the service's style directory, not into this repository:
`voice_styles/*.json` is gitignored, because a cloned voice is derived from a
recording of a real person and the file is that person's voiceprint. See
[Licensing](#licensing).

### An unheld voice is an error

A request naming a voice this service does not hold is refused with a 400 that
names the voice, rather than being quietly answered in the default voice:

```bash
curl -X POST localhost:8084/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"input": "hello", "voice": "nope"}'
# 400 {"detail": "Voice 'nope' is not available. Available voices: F1, F2, ..."}
```

An empty or absent `voice` is a different request — it names nothing, so it
takes `default_voice`.

A style file that cannot be read is reported at startup, listed under
`unreadable_voices`, and makes `/health` report `degraded`. The styles that did
read are still served.

## Docker

```bash
# Build and run directly
docker build -t supertonic-tts-service:latest .
docker run -p 8084:8084 supertonic-tts-service:latest
```

The image sets `SUPERTONIC_CACHE_DIR=/app/supertonic3`, so the weights baked at
build time and the style directory live at a knowable path. Copy a deployment's
style files into `supertonic-service/voice_styles/` before building to bake them
in, or mount one file over the running container to install a voice without
rebuilding (see the commented example in `docker-compose.audio.yml`).

Mount a *file*, not a directory: a directory mount over `voice_styles/` would
hide the ten built-in styles.

## Environment

| Variable | Default      | Description |
|----------|--------------|-----------|
| PORT       | 8084         | HTTP port |
| HOST       | 127.0.0.1    | HTTP host |
| SUPERTONIC_CACHE_DIR | `~/.cache/supertonic3` | Model and style directory; `voice_styles/` inside it is the voice catalog |

## Tests

```bash
pytest tests
```

The suite runs against a temporary style directory and a stubbed engine, so it
needs no model weights.

## Note

The `supertonic` PyPI package downloads model weights from HuggingFace on first use.
The Dockerfile pre-downloads them during build so the container starts faster.

## Licensing

The Python wrapper in this directory is MIT, like the rest of the repository
(see the root [`LICENSE`](../LICENSE)). Two other things are not:

- **The model weights** come from
  [Supertone/supertonic-3](https://huggingface.co/Supertone/supertonic-3) and
  are **BigScience Open RAIL-M**, not an open-source license. The PyPI
  `supertonic` package being MIT says nothing about them — that license covers
  the wrapper code that fetches them. Commercial use is permitted, but the
  use-based restrictions must travel downstream as an enforceable provision,
  and generated speech must be disclosed as machine generated. Because the
  Dockerfile bakes the weights into the image, **anything that ships that image
  redistributes them.**
- **Voice style files** are not distributed by this repository, and
  `voice_styles/*.json` is gitignored for that reason. A cloned voice is a
  voiceprint: keep it in the deployment, and do not use it to impersonate its
  speaker without their consent.

See the root [`NOTICE`](../NOTICE) for the full text and the other obligations
that come with the audio stack.

