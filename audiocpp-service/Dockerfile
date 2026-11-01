# audio.cpp speech-to-text service.
#
# The engine is distributed as a pinned upstream image rather than built here:
# the project publishes multi-arch CUDA images with immutable date-SHA tags.
# Override AUDIOCPP_IMAGE only to move to a deliberate new pin.
ARG AUDIOCPP_IMAGE=ghcr.io/0xshug0/audio.cpp:full-cuda12-20261020-99cd28e
FROM ${AUDIOCPP_IMAGE}

WORKDIR /app
COPY server.json /app/server.json

EXPOSE 8080

# The image's first argument selects the bundled binary; `server` is
# audiocpp_server. Models are mounted at /app/models (see server.json) and are
# never baked into this image.
CMD ["server", "--config", "/app/server.json", "--backend", "cuda", "--host", "0.0.0.0", "--port", "8080"]
