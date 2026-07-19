# Debian slim on purpose: `sharp` ships prebuilt glibc-arm64 + glibc-amd64
# binaries, so we get no compile step on the Raspberry Pi. Alpine (musl) needed
# node-gyp + a full toolchain to build from source, which was blowing up.
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install --no-install-recommends -y bash jq ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install first for better layer caching.
COPY package.json package-lock.json* .npmrc* ./
# `vite` runs at runtime via `vite preview`, so keep dev deps too.
RUN npm ci

# App source.
COPY . .

# Build the frontend into dist/ so `vite preview` can serve it.
RUN npm run build

# Persistent data lives on the HA add-on volume mounted at /data.
ENV WARDROBE_DATA_DIR=/data
ENV WARDROBE_MODEL_REFERENCE=/data/model-reference.png
ENV NODE_ENV=production
ENV PORT=4173

EXPOSE 4173

# run.sh reads /data/options.json (HA add-on config), maps each field to env
# vars, then execs `vite preview` which serves dist/ + the /api middleware.
RUN cp run.sh /usr/local/bin/run.sh && chmod +x /usr/local/bin/run.sh

CMD ["/usr/local/bin/run.sh"]
