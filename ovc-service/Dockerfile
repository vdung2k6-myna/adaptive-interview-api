# OpenVoiceChanger, pinned and headless.
#
# The upstream repository ships no Dockerfile and is written as a single-user
# local app that serves its own frontend. This image installs the backend only:
# the API is what this deployment uses, the frontend is not built, and the
# backend already handles a missing `frontend/dist` by skipping the static mount.
FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OVC_HOST=0.0.0.0 \
    OVC_PORT=8000 \
    OVC_MODELS_DIR=/models \
    OVC_HUBERT_PATH=/models/assets/hubert_base.pt \
    OVC_RMVPE_ROOT=/models/assets/rmvpe \
    OVC_UPDATE_CHECK_ENABLED=false

# git and build-essential are for the `fairseq` pin, which is installed from a
# Git source; ffmpeg and libsndfile decode the audio the converter accepts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      ffmpeg \
      git \
      libsndfile1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# A commit, not a branch: the service's API and model format are what this
# deployment is tested against, and a moving `main` would change them silently.
ARG OVC_COMMIT=8e6a00c628eafc0fd1d68c6bc13f2c17b8a46ea1
RUN git clone https://github.com/sioaeko/OpenVoiceChanger.git . \
 && git checkout --quiet "${OVC_COMMIT}" \
 && rm -rf .git

RUN pip install --no-cache-dir -r backend/requirements.txt \
 && mkdir -p /app/data

# The RVC runtime is a second install that backend/requirements.txt does not
# carry: without it the service starts and answers health, but activating an RVC
# model fails with "No module named 'rvc'" and `/api/convert/` silently returns
# the input unchanged. Pinned to the commit this deployment is tested against —
# the same reason the service itself is pinned.
ARG RVC_COMMIT=7b284a634667c34103eaaeed972b48ccdb4b893e
RUN pip install --no-cache-dir --no-deps \
      "git+https://github.com/RVC-Project/Retrieval-based-Voice-Conversion@${RVC_COMMIT}"

# Models, HuBERT/RMVPE assets and the active model's state live under this
# directory. Mount a persistent host path at /models so a replaced container
# does not lose the voice or re-download the assets.
VOLUME ["/models"]

EXPOSE 8000

CMD ["python", "-m", "backend.main"]
