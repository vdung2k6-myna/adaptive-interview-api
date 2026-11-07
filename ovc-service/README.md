# OpenVoiceChanger Service

A pinned, headless deployment of
[`sioaeko/OpenVoiceChanger`](https://github.com/sioaeko/OpenVoiceChanger) (MIT),
used by the API to speak every synthesized reply in one voice.

It is **not** a TTS engine: it converts audio to audio. The API synthesizes a
segment with a TTS engine or a TTS profile's provider, then posts that WAV here
and delivers the converted WAV. The service's active model is therefore the
voice a listener hears, whatever engine or profile produced the input.

## Why this image exists

Upstream ships no Dockerfile and is written as a single-user local application
that serves its own frontend. This image installs the **backend only**; the API
is the only client, and the backend already skips the static mount when
`frontend/dist` is absent. The commit is pinned in the Dockerfile: the service's
API and model format are what this deployment is tested against, and a moving
`main` would change them silently.

The image also installs the pinned **RVC runtime**
(`RVC-Project/Retrieval-based-Voice-Conversion`). It is a separate install that
upstream's `backend/requirements.txt` does not carry; without it the service
starts and answers health, but activating an RVC model fails with
`No module named 'rvc'` — and `/api/convert/` then answers 200 with the input
unchanged rather than reporting a failure.

## Run

From the repository root, on the app host:

```bash
docker compose -f docker-compose.ovc.yml up -d --build
```

It publishes `127.0.0.1:8085` by default. Point the API at it with:

```ini
OVC_URL=http://127.0.0.1:8085
OVC_MODEL=my-voice.pth      # the file name of the active model, below
```

The service keeps its active model **in memory only**: a restarted service
scans the models directory but activates nothing, and conversion with no active
model returns the input effectively unchanged. The API therefore activates
`OVC_MODEL` itself at boot whenever the service reports no model or a different
one. Manual activation (below) still works and is what a service with no API in
front of it needs.

The service has **no authentication**, so the bind address is the security
boundary. Keep it on loopback, or on the private interface when the API runs on
another host, and never publish it publicly. The compose file disables the
service's self-update.

## GPU acceleration (optional)

Conversion takes seconds per sentence on a CPU and a fraction of a second on a GPU. The
image already carries a CUDA-enabled PyTorch and selects CUDA itself when a device is
present, so enabling it is a device grant, not a setting.

The host needs the NVIDIA container toolkit. Prove it before starting:

```bash
docker run --rm --gpus all nvidia/cuda:12.9.0-base-ubuntu24.04 nvidia-smi
```

Start with the override beside the base file:

```bash
docker compose -f docker-compose.ovc.yml -f docker-compose.ovc.gpu.yml up -d --build
```

Confirm the device the service chose:

```bash
curl http://127.0.0.1:8085/api/config   # runtime.torch.device should be "cuda:0"
```

Activation is in memory only, so activate `OVC_MODEL` again after any recreate; the API
does this at boot. The base file alone stays CPU-only and needs no GPU.

Two limits. On a card of 4 GB or less the service runs in half precision with a reduced
conversion context, so listen to the result before relying on it. And shared with the audio
tier's audiocpp, the two do not reliably coexist on a 4 GB card — conversion intermittently
fails with CUDA out of memory, and transcription slows while conversion runs — so run the
converter with audiocpp stopped or on a larger card; see
[`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) §5.3 and §6. ONNX voice models remain on
CPU regardless: the image's onnxruntime has no CUDA provider, so acceleration applies to
RVC models.

## Provision the model and its assets

The service converts with one **active model at a time**. Models are
operator-supplied and are not shipped in this repository or the image.

1. Mount a persistent directory: `OVC_MODELS_DIR` (default `./ovc-models`).
2. Put the assets the converter needs under `models/assets/` — upstream's
   configuration expects `hubert_base.pt` and the RMVPE/crepe files there. The
   managed upstream setup downloads SHA-256-verified HuBERT and RMVPE weights
   (about 353 MiB); see its documentation.
3. Install the voice model (an `.onnx`, or an RVC `.pth`/`.pt` with its
   companion `.index`) into the models directory. A model placed there is
   scanned at startup and needs no upload. Activate it once by hand, or let the
   API do it at boot by naming it in `OVC_MODEL`:

```bash
curl -F "file=@my-voice.pth" http://127.0.0.1:8085/api/models/upload
curl -X POST http://127.0.0.1:8085/api/models/my-voice.pth/activate
curl http://127.0.0.1:8085/api/models/active
```

The active model's `name` is its **file name** (`my-voice.pth`), and that is what
`OVC_MODEL` in the API's environment must name. A mismatch is reported at the
API's boot rather than discovered by a turn.

## Getting a voice model

The service recommends no model and ships none; the choice and its licence are
the operator's. The defensible sources are:

- **Your own recording, or a speaker who consented** — 10–30 minutes of clean
  speech, trained with an RVC trainer (Applio or the RVC WebUI, both MIT).
- **A publicly licensed speech corpus** — VCTK (CC BY 4.0, attribution
  required) or LJSpeech (public domain), trained the same way.

The public RVC model hubs are dominated by unlicensed models of real people and
characters; a licence file is rare and the speaker's consent is usually absent.
See `docs/LICENSE_AUDIT.md` H1 and H3 before downloading one. Keep the corpus
attribution next to the model: an RVC model is a derived work of the speech it
was trained on.

## Health

```bash
curl http://127.0.0.1:8085/health
```

The API also reports the service's reachability and active model in its own
health.

## Licensing and consent

The code is MIT. The **model is not covered by that**: a voice model is a
voiceprint derived from a recording of a real person, and its licence and the
speaker's consent are the operator's responsibility. It must never be committed
to this repository or baked into an image — `ovc-models/` is gitignored for the
same reason Supertonic style files are (`docs/LICENSE_AUDIT.md` H3). Using a
downloaded community model of a real person raises the impersonation obligation
recorded in the audit (H1, OpenRAIL-M §4(g)).
