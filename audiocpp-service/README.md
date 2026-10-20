# audio.cpp STT Service

The speech-to-text service for the interview platform. It runs the upstream
[audio.cpp](https://github.com/0xShug0/audio.cpp) server — a compiled CUDA engine
with its own HTTP API — from a pinned container image. Unlike the three TTS
services, there is no Python wrapper here: audio.cpp already serves
`/v1/audio/transcriptions`, which is the route the API calls.

## What is pinned

| item | pin |
|---|---|
| engine image | `ghcr.io/0xshug0/audio.cpp:full-cuda12-20261020-99cd28e` |
| model | `audio-cpp/audio.cpp-gguf@02f5de92a82339ebb722ea6fdadc14b7bec43a7f` |
| model file | `Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf`, 2,473,017,600 bytes |
| model SHA-256 | `3bc2462eca3a3a8f56abcd860d0943ffdc0546547dde55a9d08589607d6f3936` |

The image tag is immutable. Do not replace it with a floating `full-cuda12`
tag: the upstream project rebuilds that tag daily.

## Provision the model

Models are not in the image. Provision them once into the tier's persistent
model directory:

```bash
python audiocpp-service/download_models.py
# -> audio-models/audiocpp/Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf
```

A second run verifies the existing file and exits without downloading. A
size or checksum mismatch is replaced, not trusted.

## Run it

The service is one member of the audio-tier compose project. From the
repository root:

```bash
docker compose -f docker-compose.audio.yml up -d audiocpp
docker compose -f docker-compose.audio.yml ps
```

Standalone, for a single-service check:

```bash
docker run --rm --gpus all \
  -p 127.0.0.1:8080:8080 \
  -v "$PWD/audio-models/audiocpp:/app/models:ro" \
  -v "$PWD/audiocpp-service/server.json:/app/server.json:ro" \
  ghcr.io/0xshug0/audio.cpp:full-cuda12-20261020-99cd28e \
  server --config /app/server.json --backend cuda --host 0.0.0.0 --port 8080
```

`GET /health` reports the server and its registered model entries. It confirms
the server is running; a lazily loaded model is not necessarily resident yet.

## Configuration

`server.json` declares `host` 0.0.0.0, `port` 8080, top-level `backend: cuda`,
and one model entry with `id: stt`. The model path is absolute inside the
container (`/app/models/...`) so it does not depend on the working directory.

The API addresses this service through `AUDIOCPP_BASE_URL`, which in the
compose tier names the STT proxy — not this container directly. The proxy is
what allows a second instance to be added without changing the API.

## Requirements

- A Linux host with an NVIDIA driver and the NVIDIA Container Toolkit.
- A GPU that can hold the model; it used ~3.1 GB of VRAM in the measured
  configuration.
- The CUDA image variant matching the host driver (`cuda12` or `cuda13`).

## Licensing

audio.cpp is Apache-2.0 (ShugoAI LLC). The model is downloaded from Hugging
Face under the terms recorded there; the repository does not redistribute it.
See the root `NOTICE` for the deployment-level obligations.
