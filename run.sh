#!/usr/bin/env bash
set -euo pipefail

# --- Load Home Assistant add-on options --------------------------------
# HA writes the user's config to /data/options.json. Map each field to the
# env var the Wardrobe app expects, then exec `vite preview`.
OPTS=/data/options.json
if [ -f "$OPTS" ]; then
  export OPENAI_API_KEY="$(jq -r '.openai_api_key // ""'      "$OPTS")"
  export OPENAI_VISION_MODEL="$(jq -r '.openai_vision_model // "gpt-5.4-mini"' "$OPTS")"
  export OPENAI_IMAGE_MODEL="$(jq -r '.openai_image_model // "gpt-image-2"'    "$OPTS")"
  export OPENAI_IMAGE_QUALITY="$(jq -r '.openai_image_quality // "high"'       "$OPTS")"
  export LOGIN_EMAIL="$(jq -r '.login_email // ""'    "$OPTS")"
  export LOGIN_CODE="$(jq -r '.login_code  // ""'    "$OPTS")"
  export AUTH_MODE="$(jq  -r '.auth_mode   // "on"'  "$OPTS")"
  export ALLOWED_HOSTS="$(jq -r '.allowed_hosts // "wardrobe.lightmotions.dk"' "$OPTS")"
fi

# Stable per-install cookie secret. Derived once, kept in /data.
if [ ! -f /data/auth-secret ]; then
  head -c 48 /dev/urandom | base64 > /data/auth-secret
fi
export AUTH_SECRET="$(cat /data/auth-secret)"

# Make sure the model reference path exists in the persistent volume so users
# can drop model-reference.png in via Samba/Code-Server. The app already
# refuses to build modeled looks without it.
mkdir -p /data/imported /data/jobs

echo "[wardrobe] starting on :$PORT (hosts: $ALLOWED_HOSTS)"
exec npx --no-install vite preview --host 0.0.0.0 --port "$PORT"
