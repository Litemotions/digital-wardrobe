FROM node:22-alpine

WORKDIR /app

# sharp needs libvips at runtime on Alpine.
RUN apk add --no-cache vips-dev bash jq && \
    rm -rf /var/cache/apk/*

# Install first for better layer caching.
COPY package.json package-lock.json* ./
# `vite` and its plugins are declared as regular dependencies (they run at
# runtime via `vite preview`), but `sharp` and native builds still benefit
# from a full install for the build step.
RUN npm ci

# App source.
COPY . .

# Build the frontend for `vite preview`.
RUN npm run build

# Persistent data lives in /data (HA add-on volume). Point the app there.
ENV WARDROBE_DATA_DIR=/data
ENV WARDROBE_MODEL_REFERENCE=/data/model-reference.png
ENV NODE_ENV=production
ENV PORT=4173

EXPOSE 4173

# `run.sh` reads /data/options.json (HA add-on config) into env, seeds the
# secrets Vite needs at RUNTIME, then starts `vite preview` which serves
# dist/ + all our API middleware.
RUN cp run.sh /usr/local/bin/run.sh
RUN chmod +x /usr/local/bin/run.sh

CMD ["/usr/local/bin/run.sh"]
