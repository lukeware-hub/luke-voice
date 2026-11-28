# Luke Voice hub in a container: a session client (POST /subscribe, GET /inbox, POST /ack) runs
# beside it and the browser opens the call window in a normal tab from the URL POST /show returns.
# Targets: light (CPU only), cuda (NVIDIA) and vulkan (any GPU, WSL2 included through dzn).

# llama.cpp's official server images, pinned to a build tag (the image keeps llama-server at /app).
ARG LLAMA_CUDA_IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda-b12826
ARG LLAMA_VULKAN_IMAGE=ghcr.io/ggml-org/llama.cpp:server-vulkan-b12826
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS node

# The light voice: Whisper and Kokoro run in the browser tab, the hub only serves and relays.
FROM ${NODE_IMAGE} AS light
WORKDIR /app
COPY .claude-plugin/ .claude-plugin/
COPY hub/ hub/
COPY window/ window/
COPY agent/ agent/
ENV LUKE_VOICE_BIND=0.0.0.0 \
    LUKE_VOICE_PROVIDER=local \
    LUKE_VOICE_IDLE_EXIT=0 \
    LUKE_VOICE_PROFILE=light \
    LUKE_VOICE_BRAIN_WAIT_MS=130000 \
    LUKE_VOICE_HOME=/data \
    CECI_MEMORY_HOME=/data/ceci
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4848
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.LUKE_VOICE_PORT || 4848) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "hub/server.mjs"]

# The natural voice on an NVIDIA card (run with --gpus all). The profile is picked from the devices.
FROM ${LLAMA_CUDA_IMAGE} AS cuda
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY .claude-plugin/ .claude-plugin/
COPY hub/ hub/
COPY window/ window/
COPY agent/ agent/
ENV LUKE_VOICE_BIND=0.0.0.0 \
    LUKE_VOICE_PROVIDER=local \
    LUKE_VOICE_IDLE_EXIT=0 \
    LUKE_VOICE_BRAIN_WAIT_MS=130000 \
    LUKE_VOICE_LLAMA_SERVER=/app/llama-server \
    LUKE_VOICE_HOME=/data \
    CECI_MEMORY_HOME=/data/ceci
# Uid 1000, like the node user of the light image, so an app beside it can read the hub.json it writes.
RUN (id -u 1000 >/dev/null 2>&1 || useradd --uid 1000 --create-home luke) && mkdir -p /data && chown 1000:1000 /data
VOLUME /data
USER 1000
EXPOSE 4848
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.LUKE_VOICE_PORT || 4848) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT []
CMD ["node", "hub/server.mjs"]

# The natural voice through Vulkan (AMD, Intel, NVIDIA; on WSL2 pass /dev/dxg and mount /usr/lib/wsl).
FROM ${LLAMA_VULKAN_IMAGE} AS vulkan
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends mesa-vulkan-drivers && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY .claude-plugin/ .claude-plugin/
COPY hub/ hub/
COPY window/ window/
COPY agent/ agent/
ENV LUKE_VOICE_BIND=0.0.0.0 \
    LUKE_VOICE_PROVIDER=local \
    LUKE_VOICE_IDLE_EXIT=0 \
    LUKE_VOICE_BRAIN_WAIT_MS=130000 \
    LUKE_VOICE_LLAMA_SERVER=/app/llama-server \
    LUKE_VOICE_HOME=/data \
    CECI_MEMORY_HOME=/data/ceci
# Uid 1000, like the node user of the light image, so an app beside it can read the hub.json it writes.
RUN (id -u 1000 >/dev/null 2>&1 || useradd --uid 1000 --create-home luke) && mkdir -p /data && chown 1000:1000 /data
VOLUME /data
USER 1000
EXPOSE 4848
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.LUKE_VOICE_PORT || 4848) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT []
CMD ["node", "hub/server.mjs"]
