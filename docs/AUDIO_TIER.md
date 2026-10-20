# The Audio Tier in Containers

The tier is one compose project: speech-to-text, three TTS engines, the
gateway, and a proxy in front of STT. It replaces the native Windows services
that `scripts/start-audio-services.bat` used to launch.

```
            +-----------------------------------------------------------+
 API :4000  |  docker compose -f docker-compose.audio.yml               |
   |        |                                                           |
   |  :8080 |  stt-proxy (Caddy) --> audiocpp xN (GPU)                  |
   +------->|                                                           |
   |  :8082 |  gateway --> kokoro :8081 / piper :8083 / supertonic :8084 |
   +------->|                                                           |
            |  models: ${AUDIO_MODELS_DIR} (persistent, read-only)      |
            +-----------------------------------------------------------+
```

Only `8080` and `8082` are published. The engine ports exist only inside the
compose network. On a server, bind the two published ports to the private
address:

```bash
export AUDIO_BIND_ADDR=10.0.0.12          # the host's private IP
docker compose -f docker-compose.audio.yml up -d --build
```

The API then points at `http://10.0.0.12:8080` (`AUDIOCPP_BASE_URL`) and
`http://10.0.0.12:8082` (`AUDIO_GATEWAY_URL`). Firewall both to the app host;
the audio services have no authentication, so the private network is the
security boundary.

## Host prerequisites

Linux with an NVIDIA driver and the NVIDIA Container Toolkit, then Docker.
Prove GPU passthrough before starting the tier:

```bash
docker run --rm --gpus all nvidia/cuda:12.9.0-base-ubuntu24.04 nvidia-smi
```

The `cuda12` engine image works on any driver that supports CUDA 12.9. Choose
the `cuda13` variant only when the driver requires it, and pin the tag.

On a development Windows machine, Docker Desktop with WSL2 and the NVIDIA
runtime is enough to run the same project; only the path syntax differs.

## Provision the models

All four model sets live under one persistent directory, `AUDIO_MODELS_DIR`
(default `./audio-models`). Nothing is baked into an image.

| directory | contents | source |
|---|---|---|
| `audiocpp/` | Qwen3-ASR 1.7B Q8_0 GGUF, 2.47 GB | `python audiocpp-service/download_models.py` (pinned revision + SHA-256) |
| `kokoro/` | Kokoro Vietnamese ONNX model and voicepack, 624 MB | `python kokoro-service/download_models.py`, then copy its `models/` |
| `piper/` | Piper voice models, 243 MB | the operator's `pipervoices/` directory |
| `supertonic/` | Supertonic 3 weights and `voice_styles/`, 386 MB | the package's cache (`SUPERTONIC_CACHE_DIR`, default `~/.cache/supertonic3`) |

From an existing development checkout, populate the first three by copying:

```bash
mkdir -p audio-models
python audiocpp-service/download_models.py
cp -r kokoro-service/models audio-models/kokoro
cp -r pipervoices audio-models/piper
cp -r ~/.cache/supertonic3/. audio-models/supertonic/
```

The supertonic mount is read-only. Provision that directory before the first
start; a missing or empty one makes the service fail rather than download
weights into a read-only mount.

On a replaced host, repeat the same step. The audio.cpp download is
deterministic (pinned revision, size, and checksum); the others depend on the
upstream sources named above.

## Deploy to a fresh host

The pilot deploys by building on the server; no private registry is used.

```bash
ssh <gpu-host>
git clone https://github.com/vdung2k6-myna/adaptive-interview-api.git
cd adaptive-interview-api
git checkout <commit>
export AUDIO_TIER_TAG="$(git rev-parse --short HEAD)"
export AUDIO_BIND_ADDR=10.0.0.12
docker compose -f docker-compose.audio.yml up -d --build
```

The four repository images are built on the host and tagged with the commit; the STT
image is built on the pinned upstream date-SHA base, pulled from public GHCR. Record the
commit — that is the record of what is running. Models must be provisioned on the host
first, as above.

Moving to a registry later changes only `build:` to `image:` in the compose file and adds
a `docker login`.

## Start, inspect, stop

```bash
docker compose -f docker-compose.audio.yml up -d --build
docker compose -f docker-compose.audio.yml ps
docker compose -f docker-compose.audio.yml logs -f audiocpp
docker compose -f docker-compose.audio.yml down
```

The repository's launchers delegate to these commands:

- `scripts/start-audio-services.bat` / `.sh` start the project and then verify
  that every service reports healthy.
- `scripts/stop-audio-services.bat` / `.sh`, and `scripts/stop-audio.js`, stop
  it.

## Health and failure

`GET /health` answers on the proxy, the gateway, and each engine. The gateway
reports `degraded` when an engine is absent rather than failing itself, so one
TTS engine going down does not take STT — or the other engines — with it.

If STT is absent, the proxy answers failures and a voice turn returns a visible
error. The start scripts report the unhealthy service and exit non-zero; they
do not report a successful start with STT missing.

## Scaling

The API has one STT address, and that address is the proxy. Add capacity
behind it without touching the API:

```bash
docker compose -f docker-compose.audio.yml up -d --scale audiocpp=2
```

The proxy balances across instances with least-connections. Whether two
instances fit on one card is a VRAM and compute-contention question — measure
it on the target card before choosing a count.

The TTS engines and gateway can be deployed as a second compose project on a
CPU host; point `AUDIO_GATEWAY_URL` at it. The service definitions carry no
shared host-local path, so the move changes addresses, not code.

## Licensing

`piper-tts` is GPL-3.0-or-later and lives only in the piper image. Supertonic
weights are OpenRAIL-M; using the tier to generate speech carries the
disclosure and non-impersonation obligations. The model weights are mounted,
not distributed inside an image. See `NOTICE` for the full list.

## Retiring the native audio.cpp install

`D:\Working\Projects\audiocpp` is no longer referenced by any launcher. Keep it
until the container has served a real transcription and matched the measured
throughput, then remove it. `audiocpp-service/download_models.py` re-creates
the model; the engine is the pinned image.
